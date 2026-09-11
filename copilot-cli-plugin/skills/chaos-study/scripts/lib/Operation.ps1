# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    The single operation seam every Azure/Chaos/Monitor call flows through.

.DESCRIPTION
    No study script issues Azure CLI or REST calls directly. They call
    Invoke-ChaosStudyOperation with a normalised, adapter-agnostic
    request, and an explicitly-selected adapter turns that into either an
    in-process Azure call (`local-az`) or a durable pause/resume against an
    external host that owns auth (`external`). There is NEVER an implicit
    fallback between adapters: the adapter is chosen once and, if it cannot be
    initialised, the study stops before it starts.

    This file owns:
      1. The dispatcher (Invoke-ChaosStudyOperation) and adapter selection.
      2. Assert-ChaosAdapterAvailable - the hard stop with remediation.
      3. The result-schema table and Test-ChaosOperationResult, which reject a
         result that does not satisfy the expected shape rather than consuming
         part of it.

    The kind -> adapter-implementation registry (and therefore the only place
    Azure is actually touched) lives in Adapters.ps1.

    Requires Common.ps1 (exit codes, hashing) to be dot-sourced first.
#>

Set-StrictMode -Version Latest

if (-not (Get-Command Get-ChaosStudyExitCode -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Common.ps1')
}
if (-not (Get-Command Get-ChaosArtifactReader -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Versioning.ps1')
}

# -- Result schema table (FR1) ----------------------------
# Table-driven, lightweight required-field/type checks - one entry per schema
# id an operation can expect. The style deliberately mirrors the
# parametersSchema flattening in ActionDiscovery.ps1: a flat list of
# { name; type; required } rather than a full JSON-Schema validator.
$ChaosOperationResultSchemas = @{
    'workspace.v1'        = @(
        @{ name = 'id'; type = 'string'; required = $true }
        @{ name = 'name'; type = 'string'; required = $true }
    )
    'scenarioList.v1'     = @(
        @{ name = 'value'; type = 'array'; required = $true }
    )
    'resource.v1'         = @(
        @{ name = 'id'; type = 'string'; required = $true }
    )
    'actionList.v1'       = @(
        @{ name = 'value'; type = 'array'; required = $true }
    )
    'configuration.v1'    = @(
        @{ name = 'name'; type = 'string'; required = $true }
    )
    'validation.v1'       = @(
        @{ name = 'status'; type = 'string'; required = $true }
    )
    'permissionFix.v1'    = @(
        @{ name = 'status'; type = 'string'; required = $false }
    )
    'run.v1'              = @(
        @{ name = 'name'; type = 'string'; required = $true }
    )
    'runStatus.v1'        = @(
        @{ name = 'status'; type = 'string'; required = $false }
    )
    'metrics.v1'          = @(
        @{ name = 'value'; type = 'array'; required = $true }
    )
    'logs.v1'             = @(
        @{ name = 'tables'; type = 'array'; required = $true }
    )
    'auth.v1'             = @(
        @{ name = 'id'; type = 'string'; required = $false }
    )
    # A permissive schema for operations whose result is only checked for
    # presence. It requires nothing, but it must still be a declared schema id
    # so a typo in -ExpectedSchema can never silently pass.
    'any.v1'              = @()
}

function Get-ChaosOperationResultSchema {
    <#
    .SYNOPSIS
        Resolve a result-schema definition by id. Unknown ids fail loudly so a
        typo can never silently accept an unvalidated result.
    #>
    param([Parameter(Mandatory)][string]$Schema)
    if (-not $ChaosOperationResultSchemas.ContainsKey($Schema)) {
        throw "Unknown operation result schema '$Schema'. Known: $(($ChaosOperationResultSchemas.Keys | Sort-Object) -join ', ')"
    }
    return $ChaosOperationResultSchemas[$Schema]
}

function Test-ChaosOperationResultType {
    <#
    .SYNOPSIS
        Loose type check for a single field value against a schema type name.
    #>
    param([AllowNull()][object]$Value, [Parameter(Mandatory)][string]$Type)
    switch ($Type) {
        'string' { return ($Value -is [string]) }
        'number' { return ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) }
        'bool'   { return ($Value -is [bool]) }
        'array'  { return (($Value -is [System.Collections.IEnumerable]) -and ($Value -isnot [string])) }
        'object' { return ($Value -is [pscustomobject] -or $Value -is [System.Collections.IDictionary]) }
        default  { return $true }
    }
}

function ConvertTo-ChaosOperationEnvelope {
    <#
    .SYNOPSIS
        Normalise an ARM-shaped result so schema checks see the fields the
        service actually returned, wherever it chose to put them.

    .DESCRIPTION
        ARM returns most of a resource under 'properties', so `az chaos
        ... validate` answers with properties.status while the schema table
        declares a top-level 'status'. The result was real and well-formed; only
        its shape differed, and the study refused it.

        This lifts a schema field to the top level ONLY when it is genuinely
        absent there and genuinely present under 'properties'. Nothing is
        invented: a status that is missing from both places stays missing and
        the schema check still fails. The original envelope is preserved intact
        - 'properties' is copied across untouched - so provenance survives
        normalisation and callers that read the nested shape keep working.

        The lifted field names are recorded on 'envelopeNormalized' so a reader
        can tell a lifted value from one the service put at the top level.
    #>
    param(
        [Parameter(Mandatory)][string]$Schema,
        [Parameter(Mandatory)][AllowNull()][object]$Result
    )

    if ($null -eq $Result) { return $Result }
    if (-not ($Result -is [pscustomobject] -or $Result -is [System.Collections.IDictionary])) { return $Result }

    $readField = {
        param($obj, $name)
        if ($null -eq $obj) { return @{ has = $false; value = $null } }
        if ($obj -is [System.Collections.IDictionary]) {
            if ($obj.Contains($name)) { return @{ has = $true; value = $obj[$name] } }
            return @{ has = $false; value = $null }
        }
        if ($obj -is [pscustomobject] -and ($obj.PSObject.Properties.Name -contains $name)) {
            return @{ has = $true; value = $obj.$name }
        }
        return @{ has = $false; value = $null }
    }

    $properties = (& $readField $Result 'properties').value
    if ($null -eq $properties) { return $Result }
    if (-not ($properties -is [pscustomobject] -or $properties -is [System.Collections.IDictionary])) { return $Result }

    $definition = Get-ChaosOperationResultSchema -Schema $Schema
    $lifted = [System.Collections.Generic.List[string]]::new()
    $projected = [ordered]@{}

    if ($Result -is [System.Collections.IDictionary]) {
        foreach ($key in $Result.Keys) { $projected[[string]$key] = $Result[$key] }
    } else {
        foreach ($prop in $Result.PSObject.Properties) { $projected[$prop.Name] = $prop.Value }
    }

    foreach ($field in $definition) {
        $top = & $readField $Result $field.name
        if ($top.has -and $null -ne $top.value) { continue }
        $nested = & $readField $properties $field.name
        if (-not $nested.has -or $null -eq $nested.value) { continue }
        $projected[$field.name] = $nested.value
        $lifted.Add([string]$field.name) | Out-Null
    }

    if ($lifted.Count -eq 0) { return $Result }
    $projected['envelopeNormalized'] = @($lifted)
    return [pscustomobject]$projected
}

function Test-ChaosOperationResult {
    <#
    .SYNOPSIS
        Validate an operation result against an expected schema id. A result
        that fails is REJECTED whole - never partially consumed.

    .DESCRIPTION
        Returns { ok; schema; problems }. The caller decides whether to throw;
        the seam always throws on a failed local-az result and refuses to
        ingest a failed external result, so a malformed result can never reach
        the study as if it were real evidence.
    #>
    param(
        [Parameter(Mandatory)][string]$Schema,
        [Parameter(Mandatory)][AllowNull()][object]$Result
    )
    $definition = Get-ChaosOperationResultSchema -Schema $Schema
    $problems = [System.Collections.Generic.List[string]]::new()

    if ($null -eq $Result) {
        if (@($definition | Where-Object { $_.required }).Count -gt 0) {
            $problems.Add("result is null but schema '$Schema' requires fields")
        }
        return [pscustomobject]@{ ok = ($problems.Count -eq 0); schema = $Schema; problems = @($problems) }
    }

    foreach ($field in $definition) {
        $has = $false
        $value = $null
        if ($Result -is [System.Collections.IDictionary]) {
            $has = $Result.Contains($field.name)
            if ($has) { $value = $Result[$field.name] }
        } elseif ($Result -is [pscustomobject]) {
            $has = ($Result.PSObject.Properties.Name -contains $field.name)
            if ($has) { $value = $Result.$($field.name) }
        }

        if (-not $has) {
            if ($field.required) { $problems.Add("missing required field '$($field.name)'") }
            continue
        }
        if ($null -eq $value) {
            if ($field.required) { $problems.Add("required field '$($field.name)' is null") }
            continue
        }
        if (-not (Test-ChaosOperationResultType -Value $value -Type $field.type)) {
            $problems.Add("field '$($field.name)' must be of type '$($field.type)'")
        }
    }

    return [pscustomobject]@{ ok = ($problems.Count -eq 0); schema = $Schema; problems = @($problems) }
}

# -- Adapter availability (hard stop, no fallback) --------
$ChaosStudyAdapters = @('local-az', 'external')

function Assert-ChaosAdapterLibraryLoaded {
    <#
    .SYNOPSIS
        Confirm the adapter library reached the CALLER'S scope. Throws a tagged
        ChaosSuiteIncomplete error when it did not.

    .DESCRIPTION
        This exists because the failure it guards is invisible. Adapters.ps1 was
        once dot-sourced inside the three functions below; a dot-source in a
        function body loads into that function's scope, so the transport helpers
        were defined just long enough for the readiness probe to approve them and
        were gone by the time anything tried to call them. Readiness said "ready",
        the next line said "undefined", and entry points that never loaded the
        library themselves quietly used the external adapter instead - which
        returns $null for a deferred operation and was read as "workspace not
        found".

        Operation.ps1 now loads the library at its own script scope, so this
        should never fire. If it does, the package is genuinely missing files and
        the right answer is to say so - not to load it here (the definitions
        would be lost again on return) and not to fall back to another adapter.
    #>
    param([string]$Because = 'an Azure operation was requested')

    $missing = @()
    foreach ($required in @('Get-ChaosOperationRegistry', 'Test-ChaosLocalAzAdapterReady')) {
        if (-not (Get-Command $required -ErrorAction SilentlyContinue)) { $missing += $required }
    }
    if ($missing.Count -eq 0) { return }

    throw ("ChaosSuiteIncomplete: the adapter library is not loaded ($Because). " +
        "Missing: $($missing -join ', '). Operation.ps1 loads lib/Adapters.ps1 at script scope; " +
        "if it is absent the skill package is incomplete. Reinstall the skill directory rather than " +
        "dot-sourcing scripts from a sibling plugin.")
}

function Assert-ChaosAdapterAvailable {
    <#
    .SYNOPSIS
        Verify a selected adapter can be initialised. Throws a tagged
        AdapterUnavailable error (map -> exit 22) with remediation when it
        cannot. There is no fallback to the other adapter - by design a study
        must not silently change how it reaches Azure.

    .DESCRIPTION
        local-az needs the shipped Azure helpers and the Azure CLI on PATH;
        the readiness probe lives in Adapters.ps1. external needs a study path to
        persist the durable request/result exchange under. An unknown adapter
        name is itself an AdapterUnavailable condition.
    #>
    param(
        [Parameter(Mandatory)][string]$Adapter,
        [string]$StudyPath
    )
    if ($Adapter -notin $ChaosStudyAdapters) {
        $remediation = "Select a supported adapter: $($ChaosStudyAdapters -join ', ')."
        Write-ChaosStudyFailure -Title 'Adapter unavailable' -Message "Unknown operation adapter '$Adapter'." -Remediation $remediation
        throw "AdapterUnavailable: unknown adapter '$Adapter'. $remediation"
    }

    if ($Adapter -eq 'local-az') {
        Assert-ChaosAdapterLibraryLoaded -Because 'the local-az adapter was requested'
        $missing = @(Test-ChaosLocalAzAdapterReady)
        if ($missing.Count -gt 0) {
            $remediation = "Install the Azure CLI and sign in with az login, or select the 'external' adapter so a host can broker Azure access."
            Write-ChaosStudyFailure -Title 'Adapter unavailable' -Message "The 'local-az' adapter cannot initialise: missing $($missing -join ', ')." -Remediation $remediation
            throw "AdapterUnavailable: local-az missing $($missing -join ', '). $remediation"
        }
    }

    if ($Adapter -eq 'external') {
        if ([string]::IsNullOrWhiteSpace($StudyPath)) {
            $remediation = "Provide -StudyPath so the durable request/result exchange has somewhere to live, or select the 'local-az' adapter."
            Write-ChaosStudyFailure -Title 'Adapter unavailable' -Message "The 'external' adapter needs a study path for its durable operation exchange." -Remediation $remediation
            throw "AdapterUnavailable: external adapter needs a study path. $remediation"
        }
    }

    return $Adapter
}

function Test-ChaosOperationSeamReady {
    <#
    .SYNOPSIS
        Whether operations can be dispatched at all, as a boolean.

    .DESCRIPTION
        Assert-ChaosAdapterAvailable is the hard stop used where an unusable
        adapter must end the study. Some read-only callers instead need to
        degrade - returning an empty list and a recorded caveat rather than
        throwing - and this is the predicate they use. It answers the same
        question with the same rules; it just declines to raise.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )
    if ([string]::IsNullOrWhiteSpace($Adapter)) { return $false }
    if (-not (Get-Command Invoke-ChaosStudyOperation -ErrorAction SilentlyContinue)) { return $false }
    if ($Adapter -notin $ChaosStudyAdapters) { return $false }
    if ($Adapter -eq 'external') { return (-not [string]::IsNullOrWhiteSpace($StudyPath)) }

    # local-az: the same readiness probe Assert uses, asked quietly. Assert
    # renders a failure card on its way to throwing, which is right for a hard
    # stop and wrong for a predicate, so the probe is repeated rather than
    # reused.
    #
    # If the probe itself is missing the suite is mis-packaged, and answering
    # "not ready" would send the caller to the external adapter to hide an
    # import bug. Say so instead.
    if (-not (Get-Command Test-ChaosLocalAzAdapterReady -ErrorAction SilentlyContinue)) {
        throw "ChaosSuiteIncomplete: Test-ChaosLocalAzAdapterReady is undefined. Adapters.ps1 did not load with Operation.ps1; the skill package is incomplete."
    }
    return (@(Test-ChaosLocalAzAdapterReady).Count -eq 0)
}

function Resolve-ChaosStudyAdapter {
    <#
    .SYNOPSIS
        Resolve the adapter to use: explicit -Adapter, then -AdapterConfig,
        then the plan-frozen adapter. NEVER an implicit default.
    #>
    param(
        [string]$Adapter,
        [AllowNull()][object]$AdapterConfig,
        [string]$StudyPath
    )
    if (-not [string]::IsNullOrWhiteSpace($Adapter)) { return $Adapter }

    if ($AdapterConfig) {
        $fromConfig = $null
        if ($AdapterConfig -is [System.Collections.IDictionary] -and $AdapterConfig.Contains('adapter')) {
            $fromConfig = [string]$AdapterConfig['adapter']
        } elseif ($AdapterConfig -is [pscustomobject] -and ($AdapterConfig.PSObject.Properties.Name -contains 'adapter')) {
            $fromConfig = [string]$AdapterConfig.adapter
        }
        if (-not [string]::IsNullOrWhiteSpace($fromConfig)) { return $fromConfig }
    }

    if (-not [string]::IsNullOrWhiteSpace($StudyPath)) {
        $reader = Get-ChaosArtifactReader -StudyPath $StudyPath -Artifact 'plan'
        if ($reader.found) {
            $plan = Read-ChaosJsonFile -Path $reader.path
            if ($plan -and ($plan.PSObject.Properties.Name -contains 'adapter') -and $plan.adapter) {
                return [string]$plan.adapter
            }
        }
    }

    return $null
}

# -- Dispatcher -------------------------------------------
function Invoke-ChaosStudyOperation {
    <#
    .SYNOPSIS
        Dispatch a normalised operation through the selected adapter.

    .DESCRIPTION
        -Kind names a registered operation; -Arguments and -Body are the
        adapter-agnostic request; -ExpectedSchema is the result shape the
        caller relies on. The adapter is resolved explicitly (never guessed)
        and asserted available before any work. local-az runs the call in
        process and validates the result; external either returns a previously
        ingested, schema-validated result or pauses the study (exit 18) with a
        durable request for a host to satisfy.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Kind,
        [Alias('Args')][hashtable]$Arguments = @{},
        [AllowNull()][object]$Body = $null,
        [Parameter(Mandatory)][string]$ExpectedSchema,
        [ValidateSet('local-az', 'external')][string]$Adapter,
        [AllowNull()][object]$AdapterConfig = $null,
        [string]$StudyPath,
        [string]$OperationHint
    )

    Assert-ChaosAdapterLibraryLoaded -Because "operation '$Kind' must be dispatched"

    $registry = Get-ChaosOperationRegistry
    if (-not $registry.ContainsKey($Kind)) {
        throw "Unknown operation kind '$Kind'. Known: $(($registry.Keys | Sort-Object) -join ', ')"
    }
    # Fail fast on an unknown schema id before any adapter work.
    Get-ChaosOperationResultSchema -Schema $ExpectedSchema | Out-Null

    $selected = Resolve-ChaosStudyAdapter -Adapter $Adapter -AdapterConfig $AdapterConfig -StudyPath $StudyPath
    if ([string]::IsNullOrWhiteSpace($selected)) {
        $remediation = "Pass -Adapter, an -AdapterConfig with an 'adapter' field, or freeze 'adapter' on the study plan."
        Write-ChaosStudyFailure -Title 'Adapter unavailable' -Message "No operation adapter was selected for kind '$Kind'." -Remediation $remediation
        throw "AdapterUnavailable: no adapter selected for kind '$Kind'. $remediation"
    }

    Assert-ChaosAdapterAvailable -Adapter $selected -StudyPath $StudyPath | Out-Null

    switch ($selected) {
        'local-az' {
            $raw = Invoke-ChaosLocalAzOperation -Kind $Kind -Arguments $Arguments -Body $Body
            # Normalise the ARM envelope BEFORE the schema check so a result that
            # is real but nested under 'properties' is read, not rejected.
            $raw = ConvertTo-ChaosOperationEnvelope -Schema $ExpectedSchema -Result $raw
            $check = Test-ChaosOperationResult -Schema $ExpectedSchema -Result $raw
            if (-not $check.ok) {
                throw "Operation '$Kind' returned a result that does not satisfy schema '$ExpectedSchema': $($check.problems -join '; ')"
            }
            return $raw
        }
        'external' {
            return (Invoke-ChaosExternalOperation -Kind $Kind -Arguments $Arguments -Body $Body `
                    -ExpectedSchema $ExpectedSchema -StudyPath $StudyPath -OperationHint $OperationHint)
        }
    }
}

# ---------------------------------------------------------------------------
# Adapter library: loaded HERE, at script scope, after every Operation function
# is defined.
#
# It used to be dot-sourced inside Assert-ChaosAdapterAvailable,
# Test-ChaosOperationSeamReady and Invoke-ChaosStudyOperation. A dot-source
# inside a function body loads into THAT FUNCTION'S scope, so the transport
# helpers existed only until the call returned. The probe therefore answered
# "local-az is ready" from inside the function that had just loaded it, while
# the caller's scope still had no Invoke-ChaosStudyAzChaos at all - readiness
# said true and the very next call said undefined. Entry points that never
# load Adapters.ps1 themselves (chaos-study-design) then fell back to the
# external adapter silently and reported "workspace not found".
#
# Loading at script scope means a dot-source of Operation.ps1 - which every
# entry point already does - brings the adapters with it, in the caller's
# scope, BEFORE any adapter selection happens.
#
# Adapters.ps1 guards its own load of Operation.ps1, so this is not circular.
if (-not (Get-Command Test-ChaosLocalAzAdapterReady -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Adapters.ps1')
}
