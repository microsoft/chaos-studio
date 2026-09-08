# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    The two operation adapters and the kind -> implementation registry.

.DESCRIPTION
    This is the ONLY file in the study suite that is permitted to touch Azure.
    Every `Invoke-ChaosStudyAzChaos`, `Invoke-ChaosStudyAzRest` and `& az` call lives inside a
    local-az registry block here; a static scan of the rest of the suite must
    find none. The dispatcher (Operation.ps1) never calls Azure itself - it
    resolves an adapter and hands off to one of:

      local-az  - run the call in process, in the registry block for the kind.
      external  - never touch Azure; build a canonical, hashed operation
                  request, persist it, and pause the study (exit 18) so a host
                  that owns auth can satisfy it. On resume the host-produced
                  result is bound by operationId + requestHash, schema-checked,
                  hashed, provenance-appended, and returned as if the call had
                  happened in process.

    Requires Common.ps1, Operation.ps1 and Study.ps1 to be dot-sourced first.
#>

Set-StrictMode -Version Latest

if (-not (Get-Command Get-ChaosDigest -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Common.ps1')
}
if (-not (Get-Command Test-ChaosOperationResult -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Operation.ps1')
}
if (-not (Get-Command Save-ChaosOperationRequest -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Study.ps1')
}
# The suite's own Azure transport. Loaded here because this is the one file
# allowed to name Azure operations, and because the six skill directories must
# carry everything they need - the published packages contain no sibling
# plugin scripts to reach for.
if (-not (Get-Command Invoke-ChaosStudyAzChaos -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'AzCli.ps1')
}

function Test-ChaosLocalAzAdapterReady {
    <#
    .SYNOPSIS
        The local-az readiness probe. Returns the list of missing dependencies
        (nothing at all when the adapter can initialise). This lives here, not in
        the dispatcher, so the names of the Azure helpers appear only in the one
        file permitted to reference Azure.

    .DESCRIPTION
        CONTRACT: this emits its result by normal pipeline enumeration, so every
        caller MUST wrap the call in @(...) to get a countable list. It must not
        return `, @($missing)`: that comma-wrapping form survives direct
        assignment but makes `@(Test-ChaosLocalAzAdapterReady).Count` equal 1 for
        an EMPTY list, because the wrapper array becomes a single element. Both
        callers here count through @(...), so an empty result read that way
        reported one phantom missing dependency and the local-az adapter was
        judged permanently unavailable.
    #>
    $missing = @()
    foreach ($required in @('Invoke-ChaosStudyAzChaos', 'Invoke-ChaosStudyAzRest')) {
        if (-not (Get-Command $required -ErrorAction SilentlyContinue)) { $missing += $required }
    }
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) { $missing += 'az' }
    return $missing
}

function Get-ChaosOperationArg {
    <#
    .SYNOPSIS
        Read a named value from a normalised argument hashtable, with a
        default. Keeps the registry blocks terse and null-safe.
    #>
    param(
        [AllowNull()][hashtable]$Arguments,
        [Parameter(Mandatory)][string]$Name,
        [AllowNull()][object]$Default = $null
    )
    if ($null -ne $Arguments -and $Arguments.ContainsKey($Name) -and $null -ne $Arguments[$Name]) {
        return $Arguments[$Name]
    }
    return $Default
}

function Get-ChaosOperationCliArgs {
    <#
    .SYNOPSIS
        Compose the argument list for an `az chaos` verb, preferring a caller
        supplied `cliArgs` array over the named-argument form.

    .DESCRIPTION
        Callers differ in how much of the command line they need to control. A
        workspace read needs only a group and a name; a workspace create also
        carries a location, a scope list and an identity flag. Rather than grow
        one named argument per flag - which would make the registry a second,
        drifting copy of the CLI surface - a caller may hand the seam the exact
        argument array it wants after the verb.

        `cliArgs` is therefore the general form and the named arguments are the
        convenience form. Both produce a request that normalises and hashes
        identically, so an external host sees one shape.
    #>
    param(
        [AllowNull()][hashtable]$Arguments,
        [Parameter(Mandatory)][string[]]$Verb,
        [AllowNull()][object]$Composed = $null
    )
    $explicit = Get-ChaosOperationArg -Arguments $Arguments -Name 'cliArgs' -Default $null
    if ($null -ne $explicit) { return @($Verb) + @($explicit) }
    return @($Verb) + @($Composed)
}

# -- Kind -> adapter-implementation registry --------------
# Each entry maps a kind to:
#   localAz  - a scriptblock (param $Arguments,$Body) that is the SOLE call
#              site of Invoke-ChaosStudyAzChaos / Invoke-ChaosStudyAzRest / & az for that kind.
#   external - { tool; methodHint } describing, for a host, what call the
#              request stands for. External blocks NEVER execute Azure.
$script:ChaosOperationRegistry = $null

function Get-ChaosOperationRegistry {
    <#
    .SYNOPSIS
        The kind -> implementation registry, built once per session.
    #>
    if ($null -ne $script:ChaosOperationRegistry) { return $script:ChaosOperationRegistry }

    $registry = @{

        # -- Workspace CRUD + recommendations ----------------
        'workspace.get' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('workspace', 'show') -Composed @(
                    '-g', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--workspace-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName')
                ))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'workspace show' }
        }
        'workspace.upsert' = @{
            localAz  = {
                param($Arguments, $Body)
                $chaosArgs = Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('workspace', 'create') -Composed @(
                    '-g', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--workspace-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName')
                )
                if ($Body) { Invoke-ChaosStudyAzChaos -ChaosArgs $chaosArgs -JsonArg $Body }
                else { Invoke-ChaosStudyAzChaos -ChaosArgs $chaosArgs }
            }
            external = @{ tool = 'az-chaos'; methodHint = 'workspace create' }
        }
        'workspace.refreshRecommendations' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('workspace', 'refresh-recommendations') -Composed @(
                    '-g', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--workspace-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName')
                ))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'workspace refresh-recommendations' }
        }
        'workspace.showEvaluation' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('workspace', 'show-evaluation') -Composed @(
                    '-g', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName')
                ))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'workspace show-evaluation' }
        }

        # -- Scopes / discovered resources -------------------
        'resource.list' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('discovered-resource', 'list') -Composed @(
                    '--resource-group', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--workspace-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName')
                ))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'discovered-resource list' }
        }
        'roleAssignments.list' = @{
            # Read-only RBAC snapshot. Chaos Studio's fix-permissions response
            # does not name the assignments it creates, so the only honest way
            # to know what a repair actually granted is to look before and after.
            localAz  = {
                param($Arguments, $Body)
                $scope = Get-ChaosOperationArg -Arguments $Arguments -Name 'scope'
                Invoke-ChaosStudyAzRest -AllowFailure -Method GET `
                    -Uri "$scope/providers/Microsoft.Authorization/roleAssignments" `
                    -ApiVersion (Get-ChaosApiVersion -Name 'roleAssignments')
            }
            external = @{ tool = 'az-rest'; methodHint = 'GET roleAssignments' }
        }
        'resource.get' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzRest -Method GET `
                    -Uri (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceId') `
                    -ApiVersion (Get-ChaosApiVersion -Name 'resources')
            }
            external = @{ tool = 'az-rest'; methodHint = 'GET resource' }
        }

        # -- Action discovery / scenarios --------------------
        'actions.list' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzRest -Method GET `
                    -Uri (Get-ChaosOperationArg -Arguments $Arguments -Name 'uri') `
                    -ApiVersion (Get-ChaosApiVersion -Name 'chaosActions')
            }
            external = @{ tool = 'az-rest'; methodHint = 'GET locations/{region}/actions' }
        }
        'scenarios.list' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'list') -Composed @(
                    '-g', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--workspace-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName')
                ))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario list' }
        }

        # -- Scenario configuration --------------------------
        'config.create' = @{
            localAz  = {
                param($Arguments, $Body)
                $chaosArgs = Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'config', 'create')
                if ($Body) { Invoke-ChaosStudyAzChaos -ChaosArgs $chaosArgs -JsonArg $Body }
                else { Invoke-ChaosStudyAzChaos -ChaosArgs $chaosArgs }
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario config create' }
        }
        'config.validate' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'config', 'validate'))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario config validate' }
        }
        'config.showValidation' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'config', 'show-validation'))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario config show-validation' }
        }
        'config.fixPermissions' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'config', 'fix-permissions'))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario config fix-permissions' }
        }
        'config.showPermissionFix' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'config', 'show-permission-fix'))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario config show-permission-fix' }
        }
        'config.show' = @{
            localAz  = {
                param($Arguments, $Body)
                # Deliberately NOT -AllowFailure: this op exists to verify a
                # deletion, and -AllowFailure collapses "not found" and "the
                # call failed" into the same $null. The caller needs the error
                # text to tell an observed absence from an unreadable answer.
                Invoke-ChaosStudyAzChaos -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'config', 'show'))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario config show' }
        }
        'config.delete' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'config', 'delete'))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario config delete' }
        }

        # -- Run lifecycle -----------------------------------
        'run.start' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'run', 'start') -Composed @(
                    '-g', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--workspace-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName'),
                    '--scenario-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'scenarioName'),
                    '--config-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'configName')
                ))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario run start' }
        }
        'run.show' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'run', 'show') -Composed @(
                    '-n', (Get-ChaosOperationArg -Arguments $Arguments -Name 'runId'),
                    '-g', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--workspace-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName'),
                    '--scenario-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'scenarioName')
                ))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario run show' }
        }
        'run.cancel' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzChaos -AllowFailure -ChaosArgs (Get-ChaosOperationCliArgs -Arguments $Arguments -Verb @('scenario', 'run', 'cancel') -Composed @(
                    '-n', (Get-ChaosOperationArg -Arguments $Arguments -Name 'runId'),
                    '-g', (Get-ChaosOperationArg -Arguments $Arguments -Name 'resourceGroup'),
                    '--workspace-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceName'),
                    '--scenario-name', (Get-ChaosOperationArg -Arguments $Arguments -Name 'scenarioName')
                ))
            }
            external = @{ tool = 'az-chaos'; methodHint = 'scenario run cancel' }
        }

        # -- Signals -----------------------------------------
        'metrics.query' = @{
            localAz  = {
                param($Arguments, $Body)
                Invoke-ChaosStudyAzRest -Method GET `
                    -Uri (Get-ChaosOperationArg -Arguments $Arguments -Name 'uri') `
                    -ApiVersion (Get-ChaosApiVersion -Name 'metrics')
            }
            external = @{ tool = 'az-rest'; methodHint = 'GET Microsoft.Insights/metrics' }
        }
        'logs.query' = @{
            localAz  = {
                param($Arguments, $Body)
                # Log Analytics speaks a non-ARM audience, so it is the one kind
                # that must shell `az rest` directly rather than via Invoke-ChaosStudyAzRest.
                $endpoint = Get-ChaosEndpoint -Name 'logAnalytics'
                $workspaceId = Get-ChaosOperationArg -Arguments $Arguments -Name 'workspaceId'
                $uri = "$endpoint/v1/workspaces/$workspaceId/query"
                $bodyFile = [System.IO.Path]::GetTempFileName()
                try {
                    $payload = if ($Body) { $Body } else { @{ query = (Get-ChaosOperationArg -Arguments $Arguments -Name 'query'); timespan = (Get-ChaosOperationArg -Arguments $Arguments -Name 'timespan') } }
                    $json = $payload | ConvertTo-Json -Depth 8 -Compress
                    [System.IO.File]::WriteAllText($bodyFile, $json, [System.Text.UTF8Encoding]::new($false))
                    $raw = & az rest --method POST --uri $uri --resource $endpoint `
                        --headers 'Content-Type=application/json' --body "@$bodyFile" --output json 2>&1
                    if ($LASTEXITCODE -ne 0) { throw (($raw | Out-String).Trim()) }
                    return ($raw | Out-String) | ConvertFrom-Json
                } finally {
                    Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue
                }
            }
            external = @{ tool = 'az-rest'; methodHint = 'POST loganalytics query' }
        }

        # -- Auth probe --------------------------------------
        'auth.probe' = @{
            localAz  = {
                param($Arguments, $Body)
                $raw = & az account show --output json 2>&1
                if ($LASTEXITCODE -ne 0) { return $null }
                return ($raw | Out-String) | ConvertFrom-Json
            }
            external = @{ tool = 'az-cli'; methodHint = 'account show' }
        }
    }

    $script:ChaosOperationRegistry = $registry
    return $registry
}

# -- local-az adapter -------------------------------------
function Invoke-ChaosLocalAzOperation {
    <#
    .SYNOPSIS
        Run a kind's local-az registry block in process. This is the boundary
        between the seam and the shipped Azure helpers.
    #>
    param(
        [Parameter(Mandatory)][string]$Kind,
        [AllowNull()][hashtable]$Arguments = @{},
        [AllowNull()][object]$Body = $null
    )
    $registry = Get-ChaosOperationRegistry
    if (-not $registry.ContainsKey($Kind)) {
        throw "Unknown operation kind '$Kind'. Known: $(($registry.Keys | Sort-Object) -join ', ')"
    }
    $block = $registry[$Kind].localAz
    return (& $block $Arguments $Body)
}

# -- external adapter: request construction ---------------
function New-ChaosOperationRequest {
    <#
    .SYNOPSIS
        Build a canonical, hashed operation request for the external adapter.

    .DESCRIPTION
        requestHash is the digest of the canonical { kind, method, args, body,
        expectedResultSchema } - the identity a host result must bind back to.
        operationId is a fresh guid; planHash is folded in from the frozen plan
        when a study path is supplied.
    #>
    param(
        [Parameter(Mandatory)][string]$Kind,
        [AllowNull()][hashtable]$Arguments = @{},
        [AllowNull()][object]$Body = $null,
        [Parameter(Mandatory)][string]$ExpectedSchema,
        [string]$StudyPath,
        [string]$OperationHint
    )
    $registry = Get-ChaosOperationRegistry
    if (-not $registry.ContainsKey($Kind)) {
        throw "Unknown operation kind '$Kind'. Known: $(($registry.Keys | Sort-Object) -join ', ')"
    }
    $external = $registry[$Kind].external
    $method = $external.methodHint
    $tool = $external.tool

    $hashInput = [ordered]@{
        kind                 = $Kind
        method               = $method
        args                 = $Arguments
        body                 = $Body
        expectedResultSchema = $ExpectedSchema
    }
    $requestHash = Get-ChaosDigest -InputObject $hashInput

    $planHash = $null
    if (-not [string]::IsNullOrWhiteSpace($StudyPath)) {
        $reader = Get-ChaosArtifactReader -StudyPath $StudyPath -Artifact 'plan'
        if ($reader.found) {
            $plan = Read-ChaosJsonFile -Path $reader.path
            if ($plan -and ($plan.PSObject.Properties.Name -contains 'frozenConfigHash')) {
                $planHash = $plan.frozenConfigHash
            }
        }
    }

    return [ordered]@{
        operationId          = [guid]::NewGuid().ToString()
        kind                 = $Kind
        method               = $method
        tool                 = $tool
        args                 = $Arguments
        body                 = $Body
        expectedResultSchema = $ExpectedSchema
        operationHint        = if ($OperationHint) { $OperationHint } else { $null }
        createdAt            = Get-ChaosUtcNow
        planHash             = $planHash
        requestHash          = $requestHash
    }
}

# -- external adapter: resume ingest ----------------------
function Resolve-ChaosPendingOperation {
    <#
    .SYNOPSIS
        Look for an already-satisfied external operation and, if the host has
        produced a result, ingest it: bind by operationId + requestHash,
        schema-validate (reject, never partially consume), hash, and append
        provenance idempotently.

    .DESCRIPTION
        Returns one of:
          { status = 'none' }               no prior request for this hash
          { status = 'pending'; operationId } request exists, no result yet
          { status = 'resolved'; result }    result ingested / cached
    #>
    param(
        [Parameter(Mandatory)][string]$StudyPath,
        [Parameter(Mandatory)][string]$RequestHash,
        [Parameter(Mandatory)][string]$ExpectedSchema
    )
    $request = Get-ChaosOperationRequestByHash -StudyPath $StudyPath -RequestHash $RequestHash
    if (-not $request) { return [pscustomobject]@{ status = 'none'; operationId = $null; result = $null } }

    $operationId = [string]$request.operationId
    $resultFile = Get-ChaosOperationResult -StudyPath $StudyPath -OperationId $operationId
    if (-not $resultFile) { return [pscustomobject]@{ status = 'pending'; operationId = $operationId; result = $null } }

    # Bind the host-produced result back to the exact request it answers.
    if (([string]$resultFile.operationId) -ne $operationId) {
        throw "Operation result for '$operationId' carries a mismatched operationId '$($resultFile.operationId)'."
    }
    if (([string]$resultFile.requestHash) -ne $RequestHash) {
        throw "Operation result for '$operationId' carries requestHash '$($resultFile.requestHash)' but the request hash is '$RequestHash'."
    }

    $payload = if ($resultFile.PSObject.Properties.Name -contains 'result') { $resultFile.result } else { $null }
    $check = Test-ChaosOperationResult -Schema $ExpectedSchema -Result $payload
    if (-not $check.ok) {
        throw "Operation result for '$operationId' does not satisfy schema '$ExpectedSchema': $($check.problems -join '; ')"
    }

    $resultHash = Get-ChaosDigest -InputObject $payload
    Add-ChaosOperationProvenance -StudyPath $StudyPath -Entry ([ordered]@{
            operationId = $operationId
            requestHash = $RequestHash
            resultHash  = $resultHash
            ingestedAt  = Get-ChaosUtcNow
            adapter     = 'external'
        }) | Out-Null

    return [pscustomobject]@{ status = 'resolved'; operationId = $operationId; result = $payload }
}

function Exit-ChaosStudyOperation {
    <#
    .SYNOPSIS
        The single exit site for a durable operation pause. Terminates the
        phase process with the ResumableOperation code so the front door can
        distinguish a pause from a failure.
    #>
    param([string]$Name = 'ResumableOperation')
    exit (Get-ChaosStudyExitCode -Name $Name)
}

# -- external adapter: dispatch ---------------------------
function Invoke-ChaosExternalOperation {
    <#
    .SYNOPSIS
        The external adapter path. Returns a previously-ingested result, or
        persists a durable request and pauses the study (exit 18).

    .DESCRIPTION
        Idempotent by requestHash: a satisfied operation returns its cached
        result without a new pause; an operation still awaiting a result
        re-pauses without writing a duplicate request; a brand-new operation
        writes operations/<operationId>.request.json, records a redacted
        command-trail line noting the requestHash, and exits 18.
    #>
    param(
        [Parameter(Mandatory)][string]$Kind,
        [AllowNull()][hashtable]$Arguments = @{},
        [AllowNull()][object]$Body = $null,
        [Parameter(Mandatory)][string]$ExpectedSchema,
        [Parameter(Mandatory)][string]$StudyPath,
        [string]$OperationHint
    )
    $registry = Get-ChaosOperationRegistry
    if (-not $registry.ContainsKey($Kind)) {
        throw "Unknown operation kind '$Kind'. Known: $(($registry.Keys | Sort-Object) -join ', ')"
    }
    $external = $registry[$Kind].external
    $method = $external.methodHint

    $requestHash = Get-ChaosDigest -InputObject ([ordered]@{
            kind                 = $Kind
            method               = $method
            args                 = $Arguments
            body                 = $Body
            expectedResultSchema = $ExpectedSchema
        })

    $resolved = Resolve-ChaosPendingOperation -StudyPath $StudyPath -RequestHash $requestHash -ExpectedSchema $ExpectedSchema
    switch ($resolved.status) {
        'resolved' { return $resolved.result }
        'pending'  {
            Write-ChaosStudyNote "Operation '$Kind' ($($resolved.operationId)) is still awaiting an external result. Pausing (exit 18)."
            Exit-ChaosStudyOperation -Name 'ResumableOperation'
        }
        default {
            $request = New-ChaosOperationRequest -Kind $Kind -Arguments $Arguments -Body $Body `
                -ExpectedSchema $ExpectedSchema -StudyPath $StudyPath -OperationHint $OperationHint
            Save-ChaosOperationRequest -StudyPath $StudyPath -Request $request | Out-Null
            Add-ChaosCommandTrailEntry -StudyPath $StudyPath -Command "operation:$Kind" -Phase 'operation' `
                -Arguments $Arguments -Note $request.requestHash | Out-Null
            Write-ChaosStudyNote "Operation '$Kind' ($($request.operationId)) requires an external host. Wrote request and paused (exit 18)."
            Exit-ChaosStudyOperation -Name 'ResumableOperation'
        }
    }
}
