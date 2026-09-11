<#
.SYNOPSIS
    One canonical answer to "which named signals does this source produce?".

.DESCRIPTION
    A study names its objective after a signal - `orderIntegrityPercent >= 99`.
    A source is named after where the number comes from - `metrics:<name>` or
    `logs:<workspaceId>#<kql>`. Those are two different identities, and every
    place that confused them produced a study that looked fine and was not:

      * scoping compared the objective's signal name to a workspace GUID and
        refused a perfectly good log objective;
      * the report looked for a source literally called `orderIntegrityPercent`,
        did not find the `logs:<guid>` one that had actually collected it, and
        declared the signal unreadable while the run truthfully reported it
        measured.

    So identity is resolved here and only here. There are two directions:

      static   from a source spec, before anything is collected - the objective
               gate needs this. For a metric the name is the metric; for a log
               query the names are the columns the KQL projects, which is why
               this file parses `summarize`/`project`/`extend` aliases.

      dynamic  from a collected signal, which already carries its own column
               names in `values`. This is authoritative: it is what was really
               measured, not what a query was predicted to return.

    Nothing here invents a name. A query whose output columns cannot be derived
    reports that fact, and the caller must ask for an explicit alias rather than
    guess - guessing is how a study ends up evaluating the wrong number.
#>

Set-StrictMode -Version Latest

# Clauses whose output columns become signal names. `summarize` and `project`
# replace the row shape; `extend` adds to it. All three can introduce aliases.
$script:ChaosKqlProjectingOperators = @('summarize', 'project', 'project-rename', 'project-away', 'extend')

function Split-ChaosKqlList {
    <#
    .SYNOPSIS
        Split a KQL clause body on top-level commas.

    .DESCRIPTION
        `summarize a = countif(x > 1, y), b = sum(z)` must split into two parts,
        not four. Commas inside brackets or quotes belong to their expression, so
        depth is tracked rather than using a plain -split.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    $parts = [System.Collections.Generic.List[string]]::new()
    $current = [System.Text.StringBuilder]::new()
    $depth = 0
    $quote = [char]0

    foreach ($ch in $Text.ToCharArray()) {
        if ($quote -ne [char]0) {
            [void]$current.Append($ch)
            if ($ch -eq $quote) { $quote = [char]0 }
            continue
        }
        switch ($ch) {
            '"' { $quote = $ch; [void]$current.Append($ch) }
            "'" { $quote = $ch; [void]$current.Append($ch) }
            '(' { $depth++; [void]$current.Append($ch) }
            '[' { $depth++; [void]$current.Append($ch) }
            ')' { $depth--; [void]$current.Append($ch) }
            ']' { $depth--; [void]$current.Append($ch) }
            ',' {
                if ($depth -le 0) {
                    [void]$parts.Add($current.ToString())
                    [void]$current.Clear()
                } else { [void]$current.Append($ch) }
            }
            default { [void]$current.Append($ch) }
        }
    }
    [void]$parts.Add($current.ToString())
    return @($parts | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-ChaosKqlTermName {
    <#
    .SYNOPSIS
        The output column name one `summarize`/`project` term produces, or $null.

    .DESCRIPTION
        `orderIntegrityPercent = 100.0 * ok / total` names its output. A bare
        `OrderId` passes a column through under its own name. Anything else -
        `count()`, `avg(Latency)` - is an unnamed expression: KQL will invent a
        name for it, and a study must not try to guess which, so it returns
        $null and the caller reports that an explicit alias is required.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Term)

    $term = $Term.Trim()
    if ([string]::IsNullOrWhiteSpace($term)) { return $null }

    # A single '=' that is not part of ==, !=, >=, <= is an assignment.
    $assignment = [regex]::Match($term, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)')
    if ($assignment.Success) { return $assignment.Groups[1].Value }

    # `project-rename new = old` is covered above. A bare identifier is a
    # pass-through column and keeps its name.
    if ($term -match '^[A-Za-z_][A-Za-z0-9_]*$') { return $term }

    return $null
}

function Get-ChaosKqlProjectedName {
    <#
    .SYNOPSIS
        The named columns a KQL query is expected to output.

    .OUTPUTS
        { names; unnamedTerms; resolved }
        `resolved` is $false when the query has no projecting clause at all, in
        which case the output shape is the source table's and cannot be known
        here without querying it.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Query)

    $names = [System.Collections.Generic.List[string]]::new()
    $unnamed = [System.Collections.Generic.List[string]]::new()
    $sawProjection = $false

    if ([string]::IsNullOrWhiteSpace($Query)) {
        return [pscustomobject]@{ names = @(); unnamedTerms = @(); resolved = $false }
    }

    foreach ($segment in @($Query -split '\|')) {
        $trimmed = $segment.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }

        $head = [regex]::Match($trimmed, '^([A-Za-z][A-Za-z\-]*)\s')
        if (-not $head.Success) { continue }
        $operator = $head.Groups[1].Value.ToLowerInvariant()
        if ($script:ChaosKqlProjectingOperators -notcontains $operator) { continue }
        if ($operator -eq 'project-away') { continue }

        $sawProjection = $true
        $body = $trimmed.Substring($head.Groups[1].Value.Length).Trim()

        # `summarize <terms> by <groups>` - both sides become output columns.
        $bodies = @($body)
        if ($operator -eq 'summarize') {
            $byMatch = [regex]::Match($body, '\sby\s', 'IgnoreCase')
            if ($byMatch.Success) {
                $bodies = @(
                    $body.Substring(0, $byMatch.Index)
                    $body.Substring($byMatch.Index + $byMatch.Length)
                )
            }
        }

        foreach ($piece in $bodies) {
            foreach ($term in (Split-ChaosKqlList -Text $piece)) {
                $name = Get-ChaosKqlTermName -Term $term
                if ($null -ne $name) {
                    if (-not $names.Contains($name)) { [void]$names.Add($name) }
                } else {
                    [void]$unnamed.Add($term)
                }
            }
        }
    }

    return [pscustomobject]@{
        names        = @($names)
        unnamedTerms = @($unnamed)
        resolved     = $sawProjection
    }
}

function Get-ChaosSignalSourceIdentity {
    <#
    .SYNOPSIS
        Resolve one `-SignalSource` spec into the identity it will be collected
        under and the signal names it can produce.

    .OUTPUTS
        { raw; kind; id; workspaceId; query; names; resolved; unnamedTerms }

        `id` matches what the collector stores as a result's `source`, so a
        collected result can be tied back to the spec that asked for it.
        `names` is empty with resolved:$false when the names cannot be derived -
        never a guess.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Spec)

    $raw = [string]$Spec
    $trimmed = $raw.Trim()

    if ($trimmed.StartsWith('logs:', [System.StringComparison]::OrdinalIgnoreCase)) {
        $rest = $trimmed.Substring('logs:'.Length)
        $workspaceId = $rest
        $query = ''
        if ($rest.Contains('#')) {
            $split = $rest.Split('#', 2)
            $workspaceId = $split[0].Trim()
            $query = $split[1]
        }
        $projected = Get-ChaosKqlProjectedName -Query $query
        return [pscustomobject]@{
            raw          = $raw
            kind         = 'logs'
            id           = "logs:$workspaceId"
            resourceId   = $null
            workspaceId  = $workspaceId
            query        = $query
            names        = @($projected.names)
            resolved     = [bool]$projected.resolved
            unnamedTerms = @($projected.unnamedTerms)
        }
    }

    if ($trimmed.StartsWith('metrics:', [System.StringComparison]::OrdinalIgnoreCase)) {
        $name = $trimmed.Substring('metrics:'.Length).Trim()

        # A metric source may be resource-scoped: `metrics:<resourceId>#<MetricName>`.
        # The resource id is the *scope*, not the signal name - the name is the
        # metric. Treating the whole remainder as the name made every
        # resource-scoped probe untraceable, because nobody writes (or collects)
        # a signal called '/subscriptions/../r#Availability'. Both the metric
        # name and the fully qualified form are accepted so artifacts written
        # either way keep matching.
        $metricName = $name
        $resourceId = $null
        $hash = $name.LastIndexOf('#')
        if ($hash -gt 0 -and $hash -lt ($name.Length - 1)) {
            $resourceId = $name.Substring(0, $hash).Trim()
            $metricName = $name.Substring($hash + 1).Trim()
        }

        $names = @($metricName, $name) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -Unique

        return [pscustomobject]@{
            raw          = $raw
            kind         = 'metrics'
            id           = "metrics:$name"
            resourceId   = $resourceId
            workspaceId  = $null
            query        = $null
            names        = @($names)
            resolved     = -not [string]::IsNullOrWhiteSpace($metricName)
            unnamedTerms = @()
        }
    }

    # A bare name is its own signal.
    return [pscustomobject]@{
        raw          = $raw
        kind         = 'unknown'
        id           = $trimmed
        resourceId   = $null
        workspaceId  = $null
        query        = $null
        names        = @($trimmed | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        resolved     = -not [string]::IsNullOrWhiteSpace($trimmed)
        unnamedTerms = @()
    }
}

function Test-ChaosSignalNameMatch {
    <#
    .SYNOPSIS
        Does a candidate output-column name refer to the same signal as the
        objective names?

    .DESCRIPTION
        KQL column names are case-sensitive, so an exact match is preferred. A
        case-insensitive match is still accepted, because refusing to evaluate
        an objective over a casing difference is a worse failure than the
        casing itself - but it is a match, not a rename: nothing is rewritten.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Candidate,
        [Parameter(Mandatory)][AllowEmptyString()][string]$SignalName
    )
    if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($SignalName)) { return $false }
    if ($Candidate -ceq $SignalName) { return $true }
    return ($Candidate -ieq $SignalName)
}

function Test-ChaosSourceProducesSignal {
    <#
    .SYNOPSIS
        Static check: could this source spec produce this named signal?

    .OUTPUTS
        { matched; reason; identity }
        `matched` is $null - not $false - when the source's output names cannot
        be derived. Unknown is not a refusal, and the caller must say so.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Spec,
        [Parameter(Mandatory)][AllowEmptyString()][string]$SignalName
    )

    $identity = Get-ChaosSignalSourceIdentity -Spec $Spec
    foreach ($name in @($identity.names)) {
        if (Test-ChaosSignalNameMatch -Candidate $name -SignalName $SignalName) {
            return [pscustomobject]@{ matched = $true; reason = "'$Spec' projects '$name'."; identity = $identity }
        }
    }

    # A probe may name the source spec verbatim rather than the signal it
    # projects. That is unambiguous - it can only ever match the one source it
    # is character-for-character equal to - and refusing it produced the
    # self-contradicting "'X' is not among the configured sources (X)".
    foreach ($alias in @($identity.raw, $identity.id)) {
        if (-not [string]::IsNullOrWhiteSpace($alias) -and $alias -ieq $SignalName) {
            return [pscustomobject]@{ matched = $true; reason = "'$SignalName' names this source itself."; identity = $identity }
        }
    }

    if (-not $identity.resolved) {
        return [pscustomobject]@{
            matched  = $null
            reason   = "The output column names of '$Spec' cannot be derived, so whether it produces '$SignalName' is unknown."
            identity = $identity
        }
    }

    if (@($identity.unnamedTerms).Count -gt 0) {
        return [pscustomobject]@{
            matched  = $null
            reason   = "'$Spec' projects unnamed expression(s) ($($identity.unnamedTerms -join ', ')), so whether one of them is '$SignalName' cannot be known. Give it an explicit alias."
            identity = $identity
        }
    }

    return [pscustomobject]@{
        matched  = $false
        reason   = "'$Spec' projects $(if (@($identity.names).Count -eq 0) { 'no named column' } else { "'" + (@($identity.names) -join "', '") + "'" }), not '$SignalName'."
        identity = $identity
    }
}

function Select-ChaosSignalByName {
    <#
    .SYNOPSIS
        Dynamic lookup: the collected signal that actually carries this name.

    .DESCRIPTION
        Authoritative, because it reads what was measured rather than what a
        spec predicted. A log result stores its projected columns in `values`,
        so `orderIntegrityPercent` is found there whatever the source id is.
        Source-name identity (`metrics:<name>`) is checked too, for series that
        summarise to first/last/mean rather than to a named column.

        A measured zero is a match. Only a genuinely absent name is a miss.
    #>
    param(
        [AllowNull()][object[]]$Signals,
        [Parameter(Mandatory)][AllowEmptyString()][string]$SignalName,
        [AllowNull()][AllowEmptyCollection()][string[]]$Sources = @()
    )

    $candidates = @(@($Signals) | Where-Object { $null -ne $_ -and $null -ne $_.values })
    if ($candidates.Count -eq 0 -or [string]::IsNullOrWhiteSpace($SignalName)) { return $null }

    # 1. The name is a column the result actually carries.
    foreach ($signal in $candidates) {
        $map = Get-ChaosSignalValueMap -Signal $signal
        foreach ($key in @($map.Keys)) {
            if (Test-ChaosSignalNameMatch -Candidate ([string]$key) -SignalName $SignalName) { return $signal }
        }
    }

    # 2. The result's own id names the signal (a metric series).
    foreach ($signal in $candidates) {
        $source = [string]$signal.source
        if ($source -ceq $SignalName -or $source -ceq "metrics:$SignalName") { return $signal }
        if ($source -ieq $SignalName -or $source -ieq "metrics:$SignalName") { return $signal }
    }

    # 3. A configured source that resolves to this name, matched back to the
    #    result collected under that source's id.
    foreach ($spec in @($Sources)) {
        if ([string]::IsNullOrWhiteSpace($spec)) { continue }
        $test = Test-ChaosSourceProducesSignal -Spec $spec -SignalName $SignalName
        if ($test.matched -ne $true) { continue }
        $id = [string]$test.identity.id
        foreach ($signal in $candidates) {
            if ([string]$signal.source -ieq $id) { return $signal }
        }
    }

    return $null
}
