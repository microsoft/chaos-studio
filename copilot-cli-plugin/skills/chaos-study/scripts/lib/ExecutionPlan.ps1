# The single canonical reader for a Chaos execution plan.
#
# Scope and run both have to answer the same question - "which legs actually
# execute?" - and they used to answer it with two separate projections. They
# drifted: the run mirror could not expand a tree the scope side could, and
# neither could read the shape the service actually returns. A run then compared
# its hash to scope's and either refused a matching plan or, worse, agreed by
# accident. There is now ONE model and ONE hash, used by both.
#
# The live shape, as observed: `properties.executionPlanJson` is a JSON STRING;
# decoding it yields an object whose `actions` is an OBJECT MAP keyed by action
# name - not a steps/branches tree - and whose per-action skip flag is `skip`.
# Each action reports the targets the service resolved for it under
# `properties.targetResources[]`, each entry carrying a
# `fullyQualifiedIdentifier` - the ARM id of the resource the fault will hit.
# That list is the only place the plan says WHERE the blast lands, so it is what
# the leg identities and the consent hash are built from.

Set-StrictMode -Version Latest

function Get-ChaosPlanField {
    <#
    .SYNOPSIS
        Read the first present field from an object, hashtable or PSCustomObject,
        trying each candidate name in order. Absent yields $null.
    #>
    param(
        [AllowNull()][object]$Node,
        [Parameter(Mandatory)][string[]]$Names
    )

    if ($null -eq $Node) { return $null }

    foreach ($name in $Names) {
        if ($Node -is [System.Collections.IDictionary]) {
            if ($Node.Contains($name)) { return $Node[$name] }
            continue
        }
        $prop = $Node.PSObject.Properties[$name]
        if ($null -ne $prop) { return $prop.Value }
    }
    return $null
}

function ConvertFrom-ChaosExecutionPlanPayload {
    <#
    .SYNOPSIS
        Decode an `executionPlanJson` string into an object.

    .DESCRIPTION
        The service returns the plan as a JSON string nested inside the ARM
        envelope. A string that will not decode is NOT treated as "no plan" -
        that would read as zero legs, and zero legs is indistinguishable from a
        scope that safely excluded everything. Undecodable returns the explicit
        marker $null plus a reason so the caller can refuse rather than guess.
    #>
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return [pscustomobject]@{ plan = $null; error = $null } }
    if ($Value -isnot [string]) { return [pscustomobject]@{ plan = $Value; error = $null } }
    if ([string]::IsNullOrWhiteSpace($Value)) { return [pscustomobject]@{ plan = $null; error = 'the execution plan string was empty' } }

    try {
        return [pscustomobject]@{ plan = ($Value | ConvertFrom-Json -ErrorAction Stop); error = $null }
    }
    catch {
        return [pscustomobject]@{ plan = $null; error = "the execution plan JSON could not be decoded: $($_.Exception.Message)" }
    }
}

function Get-ChaosExecutionPlanRoot {
    <#
    .SYNOPSIS
        Every object worth searching for legs, in preference order, with any
        `executionPlanJson` string decoded along the way.

    .DESCRIPTION
        Returns `{ roots[], errors[] }`. A decode failure is surfaced in `errors`
        rather than swallowed, because "unreadable" and "empty" must never be
        reported as the same thing.
    #>
    param([AllowNull()][object]$ExecutionPlan)

    $roots = @()
    $errors = @()
    if ($null -eq $ExecutionPlan) { return [pscustomobject]@{ roots = @(); errors = @() } }

    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue($ExecutionPlan)
    $seen = 0

    while ($queue.Count -gt 0 -and $seen -lt 32) {
        $node = $queue.Dequeue()
        $seen++
        if ($null -eq $node) { continue }
        $roots += $node

        foreach ($nested in @('properties', 'executionPlan', 'plan')) {
            $child = Get-ChaosPlanField -Node $node -Names @($nested)
            if ($null -ne $child -and $child -isnot [string]) { $queue.Enqueue($child) }
        }

        $json = Get-ChaosPlanField -Node $node -Names @('executionPlanJson', 'executionPlanJSON')
        if ($null -ne $json) {
            $decoded = ConvertFrom-ChaosExecutionPlanPayload -Value $json
            if ($null -ne $decoded.error) { $errors += $decoded.error }
            if ($null -ne $decoded.plan) { $queue.Enqueue($decoded.plan) }
        }
    }

    return [pscustomobject]@{ roots = @($roots); errors = @($errors) }
}

function Get-ChaosLegSkipState {
    <#
    .SYNOPSIS
        Decide whether a leg runs: 'run', 'skip', or 'unknown'.

    .DESCRIPTION
        Three states, not two, and that is the point. A skip flag that is
        PRESENT but not interpretable as a boolean must never fall through to
        "runs" - that is how an excluded target ends up in the blast radius
        while the plan claims it was skipped. It also must not fall through to
        "skipped", which would understate what executes. It is 'unknown', and an
        unknown leg makes the whole effective-plan projection unusable until a
        human looks at it.

        Only an ABSENT skip signal means the leg runs; the service states skips
        explicitly, so absence is a real answer rather than a guess.
    #>
    param([AllowNull()][object]$Leg)

    # `skip` is the live field name. `skipped` is accepted because earlier
    # recorded plans use it; both are read the same way.
    foreach ($name in @('skip', 'skipped', 'isSkipped')) {
        $value = Get-ChaosPlanField -Node $Leg -Names @($name)
        if ($null -eq $value) { continue }
        if ($value -is [bool]) { return $(if ($value) { 'skip' } else { 'run' }) }
        $text = ([string]$value).Trim().ToLowerInvariant()
        if ($text -in @('true', 'yes')) { return 'skip' }
        if ($text -in @('false', 'no')) { return 'run' }
        return 'unknown'
    }

    foreach ($name in @('executable', 'willExecute', 'included')) {
        $value = Get-ChaosPlanField -Node $Leg -Names @($name)
        if ($null -eq $value) { continue }
        if ($value -is [bool]) { return $(if ($value) { 'run' } else { 'skip' }) }
        $text = ([string]$value).Trim().ToLowerInvariant()
        if ($text -in @('true', 'yes')) { return 'run' }
        if ($text -in @('false', 'no')) { return 'skip' }
        return 'unknown'
    }

    $reason = Get-ChaosPlanField -Node $Leg -Names @('reason', 'skipReason', 'skippedReason')
    if (-not [string]::IsNullOrWhiteSpace([string]$reason)) { return 'skip' }

    $status = [string](Get-ChaosPlanField -Node $Leg -Names @('status', 'state'))
    if (-not [string]::IsNullOrWhiteSpace($status)) {
        $normalized = $status.Trim().ToLowerInvariant().Replace(' ', '').Replace('-', '')
        if ($normalized -in @('skipped', 'notapplicable', 'excluded', 'unsupported', 'notsupported', 'ineligible', 'filtered')) { return 'skip' }
    }

    return 'run'
}

function Get-ChaosLegSelector {
    <#
    .SYNOPSIS
        A stable string identifying a leg's target.
    #>
    param([AllowNull()][object]$Leg)

    # The service's own resolved identity wins over every other name. A
    # `targetResources` entry carries BOTH a `fullyQualifiedIdentifier` (the ARM
    # id of the resource that will actually be hit) and often a short `name`;
    # picking the short name would make two resources with the same leaf name in
    # different resource groups hash identically, which is exactly the collision
    # the consent gate exists to prevent.
    $fqid = Get-ChaosPlanField -Node $Leg -Names @('fullyQualifiedIdentifier', 'fullyQualifiedResourceId', 'targetResourceId')
    if (-not [string]::IsNullOrWhiteSpace([string]$fqid)) { return [string]$fqid }

    $selector = Get-ChaosPlanField -Node $Leg -Names @('legSelector', 'selector', 'targetSelector', 'key', 'name')
    if (-not [string]::IsNullOrWhiteSpace([string]$selector)) { return [string]$selector }

    $target = Get-ChaosPlanField -Node $Leg -Names @('target', 'resource')
    if ($null -ne $target -and $target -isnot [string]) {
        $nestedFqid = Get-ChaosPlanField -Node $target -Names @('fullyQualifiedIdentifier', 'fullyQualifiedResourceId', 'targetResourceId')
        if (-not [string]::IsNullOrWhiteSpace([string]$nestedFqid)) { return [string]$nestedFqid }
        $nested = Get-ChaosPlanField -Node $target -Names @('legSelector', 'selector', 'targetSelector', 'key', 'name')
        if (-not [string]::IsNullOrWhiteSpace([string]$nested)) { return [string]$nested }
    }

    $resource = Get-ChaosPlanField -Node $Leg -Names @('resourceSelector', 'resourceId', 'id')
    if ([string]::IsNullOrWhiteSpace([string]$resource) -and $null -ne $target -and $target -isnot [string]) {
        $resource = Get-ChaosPlanField -Node $target -Names @('resourceSelector', 'resourceId', 'id')
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$resource)) { return [string]$resource }
    if ($null -ne $target -and $target -is [string]) { return [string]$target }
    return ''
}

function Get-ChaosPlanActionTarget {
    <#
    .SYNOPSIS
        The list of targets an action executes against, preferring the target
        list the SERVICE resolved over anything the client declared.

    .DESCRIPTION
        An observed live plan puts the resolved targets under
        `properties.targetResources[]`, each entry carrying a
        `fullyQualifiedIdentifier` - not under the `targets`/`selectors`/
        `resources` names this reader used to look for. The consequence was not
        a crash: expansion found no targets, fell through to the single
        null-target leg, and the leg identity degraded to
        `<action>::<action>`. The projection then described "one leg, named
        after the action" for a plan that in fact named the exact VMSS it would
        stop, and two plans that differed only in which resource they hit
        hashed the same. The consent gate was therefore blind to the one field
        that says where the blast lands.

        Returns `{ targets; source }`. `source` is recorded so a reader can tell
        a service-resolved target list from a client-declared one; `targets` is
        `$null` (not an empty array) when no list was found at all, because
        "no list" and "an empty list" mean different things to the caller.
    #>
    param([AllowNull()][object]$Action)

    if ($null -eq $Action) { return [pscustomobject]@{ targets = $null; source = $null } }

    # Search the action node and its `properties` child. The service nests the
    # resolved list one level down; a client-shaped plan keeps it at the top.
    $nodes = @($Action)
    $properties = Get-ChaosPlanField -Node $Action -Names @('properties')
    if ($null -ne $properties -and $properties -isnot [string]) { $nodes += $properties }

    foreach ($name in @('targetResources', 'targets', 'selectors', 'resources')) {
        foreach ($node in $nodes) {
            $value = Get-ChaosPlanField -Node $node -Names @($name)
            if ($null -eq $value) { continue }
            return [pscustomobject]@{ targets = $value; source = $name }
        }
    }

    return [pscustomobject]@{ targets = $null; source = $null }
}

function Expand-ChaosPlanActionLeg {
    <#
    .SYNOPSIS
        Expand one action entry into one leg per target, preserving the action
        key so the projection survives normalization.
    #>
    param(
        [AllowNull()][string]$ActionName,
        [AllowNull()][object]$Action
    )

    $resolvedName = $ActionName
    if ([string]::IsNullOrWhiteSpace($resolvedName)) {
        $resolvedName = [string](Get-ChaosPlanField -Node $Action -Names @('action', 'actionName', 'name', 'type', 'actionId'))
    }

    $resolvedTargets = Get-ChaosPlanActionTarget -Action $Action
    $targets = $resolvedTargets.targets
    $targetSource = $resolvedTargets.source
    $actionState = Get-ChaosLegSkipState -Leg $Action

    if ($null -eq $targets) {
        return @([ordered]@{
                action       = $resolvedName
                target       = $null
                selector     = (Get-ChaosLegSelector -Leg $Action)
                skipState    = $actionState
                targetSource = $null
                reason       = (Get-ChaosPlanField -Node $Action -Names @('reason', 'skipReason', 'skippedReason', 'status', 'state'))
            })
    }

    $legs = @()
    foreach ($target in @($targets | Where-Object { $null -ne $_ })) {
        # A target that carries no skip signal of its own inherits the action's,
        # so an action skipped as a whole does not report its targets as running.
        $targetState = Get-ChaosLegSkipState -Leg $target
        $state = if ($targetState -eq 'run' -and $actionState -ne 'run') { $actionState } else { $targetState }
        $reason = Get-ChaosPlanField -Node $target -Names @('reason', 'skipReason', 'skippedReason', 'status', 'state')
        if ($null -eq $reason) { $reason = Get-ChaosPlanField -Node $Action -Names @('reason', 'skipReason', 'skippedReason') }
        # A bare resource id IS the selector. Falling through to '(unnamed leg)'
        # when the plan named the target perfectly well made the skip list
        # unreadable, which is the one place an operator most needs to see
        # exactly which resource was left out.
        $selector = Get-ChaosLegSelector -Leg $target
        if ([string]::IsNullOrWhiteSpace($selector) -and ($target -is [string])) { $selector = [string]$target }
        if ([string]::IsNullOrWhiteSpace($selector)) { $selector = $resolvedName }
        $legs += [ordered]@{
            action       = $resolvedName
            target       = $target
            selector     = $selector
            skipState    = $state
            targetSource = $targetSource
            reason       = $reason
        }
    }
    return @($legs)
}

function Get-ChaosExecutionPlanLeg {
    <#
    .SYNOPSIS
        The canonical flat leg list for any supported execution-plan shape.

    .DESCRIPTION
        Returns `{ legs[], errors[] }`. Supported shapes, in order:
          1. a direct `legs`/`effectiveLegs` list;
          2. an `actions` OBJECT MAP keyed by action name - the live shape;
          3. an `actions` list;
          4. a steps -> branches -> actions -> targets tree.

        A plan that matches none of these yields zero legs AND an error, because
        "I could not read this" must never be presented as "nothing will run".
    #>
    param([AllowNull()][object]$ExecutionPlan)

    $resolved = Get-ChaosExecutionPlanRoot -ExecutionPlan $ExecutionPlan
    $roots = @($resolved.roots)
    $errors = @($resolved.errors)

    if ($roots.Count -eq 0) { return [pscustomobject]@{ legs = @(); errors = @($errors) } }

    foreach ($root in $roots) {
        $legs = Get-ChaosPlanField -Node $root -Names @('legs', 'effectiveLegs')
        if ($null -eq $legs) { continue }
        $normalized = @()
        foreach ($leg in @($legs | Where-Object { $null -ne $_ })) {
            $normalized += [ordered]@{
                action    = [string](Get-ChaosPlanField -Node $leg -Names @('action', 'actionName', 'actionId', 'type'))
                target    = (Get-ChaosPlanField -Node $leg -Names @('target', 'resource'))
                selector  = (Get-ChaosLegSelector -Leg $leg)
                skipState = (Get-ChaosLegSkipState -Leg $leg)
                reason    = (Get-ChaosPlanField -Node $leg -Names @('reason', 'skipReason', 'skippedReason', 'status', 'state'))
            }
        }
        return [pscustomobject]@{ legs = @($normalized); errors = @($errors) }
    }

    foreach ($root in $roots) {
        $actions = Get-ChaosPlanField -Node $root -Names @('actions')
        if ($null -eq $actions) { continue }

        # The live shape: an object map keyed by action name.
        if ($actions -is [System.Collections.IDictionary]) {
            $expanded = @()
            foreach ($key in @($actions.Keys)) { $expanded += Expand-ChaosPlanActionLeg -ActionName ([string]$key) -Action $actions[$key] }
            if (@($expanded).Count -gt 0) { return [pscustomobject]@{ legs = @($expanded); errors = @($errors) } }
            continue
        }
        if ($actions -isnot [System.Array] -and $actions -isnot [System.Collections.IEnumerable]) {
            $expanded = @()
            foreach ($prop in @($actions.PSObject.Properties)) { $expanded += Expand-ChaosPlanActionLeg -ActionName $prop.Name -Action $prop.Value }
            if (@($expanded).Count -gt 0) { return [pscustomobject]@{ legs = @($expanded); errors = @($errors) } }
            continue
        }

        $expanded = @()
        foreach ($action in @($actions | Where-Object { $null -ne $_ })) { $expanded += Expand-ChaosPlanActionLeg -ActionName $null -Action $action }
        if (@($expanded).Count -gt 0) { return [pscustomobject]@{ legs = @($expanded); errors = @($errors) } }
    }

    foreach ($root in $roots) {
        $steps = Get-ChaosPlanField -Node $root -Names @('steps')
        if ($null -eq $steps) { continue }
        $expanded = @()
        # Nulls are dropped at every level deliberately: @($null) is a
        # one-element array, so iterating an absent list would manufacture a
        # phantom leg carrying no skip signal at all.
        foreach ($step in @($steps | Where-Object { $null -ne $_ })) {
            $branches = Get-ChaosPlanField -Node $step -Names @('branches')
            foreach ($branch in @($branches | Where-Object { $null -ne $_ })) {
                $actions = Get-ChaosPlanField -Node $branch -Names @('actions')
                foreach ($action in @($actions | Where-Object { $null -ne $_ })) {
                    $expanded += Expand-ChaosPlanActionLeg -ActionName $null -Action $action
                }
            }
        }
        if (@($expanded).Count -gt 0) { return [pscustomobject]@{ legs = @($expanded); errors = @($errors) } }
    }

    $errors += 'the execution plan did not carry legs, actions or steps in any recognised shape'
    return [pscustomobject]@{ legs = @(); errors = @($errors) }
}

function Resolve-ChaosEffectiveLeg {
    <#
    .SYNOPSIS
        The declared-vs-effective leg model:
        `{ total, executable, skipped[], undetermined[], errors[], executableSelectors[] }`.

    .DESCRIPTION
        `undetermined` is the safety-critical addition. A leg whose skip signal
        could not be read counts towards neither executable nor skipped; it is
        listed so the caller refuses to proceed on a plan it cannot honestly
        describe. `executable` is therefore total minus skipped minus
        undetermined, and never includes a leg nobody could classify.

        `executableLegs` carries the same legs as `executableSelectors` but
        keeps the action identity alongside the target, so a projection built
        from this model can distinguish which action runs where.
    #>
    param([AllowNull()][object]$ExecutionPlan)

    $read = Get-ChaosExecutionPlanLeg -ExecutionPlan $ExecutionPlan
    $legs = @($read.legs)

    $skipped = @()
    $undetermined = @()
    $executableSelectors = @()
    $executableLegs = @()

    foreach ($leg in $legs) {
        $selector = [string]$leg.selector
        $action = if ([string]::IsNullOrWhiteSpace([string]$leg.action)) { $null } else { [string]$leg.action }
        $reason = [string]$leg.reason
        # Provenance, not identity: two plans that name the same resource are the
        # same plan even if one arrived as `targetResources` and the other as
        # `targets`. It is carried so a reader can see whether the target list
        # came from the service or from the client's own declaration.
        $targetSource = Get-ChaosPlanField -Node $leg -Names @('targetSource')

        switch ($leg.skipState) {
            'skip' {
                $skipped += [pscustomobject]@{
                    legSelector      = $selector
                    action           = $action
                    resourceSelector = $selector
                    targetSource     = $targetSource
                    reason           = if ([string]::IsNullOrWhiteSpace($reason)) { 'no reason reported' } else { $reason }
                }
            }
            'unknown' {
                $undetermined += [pscustomobject]@{
                    legSelector      = $selector
                    action           = $action
                    resourceSelector = $selector
                    targetSource     = $targetSource
                    reason           = 'the plan did not state whether this leg runs in a form this tool can read'
                }
            }
            default {
                $executableSelectors += $selector
                # The legs that actually execute carry their action identity too.
                # A projection that recorded only which legs were SKIPPED could
                # not tell "action A runs against target T" apart from "action B
                # runs against target T" when the counts happened to agree.
                $executableLegs += [pscustomobject]@{
                    legSelector      = $selector
                    action           = $action
                    resourceSelector = $selector
                    targetSource     = $targetSource
                }
            }
        }
    }

    $total = @($legs).Count
    $executable = $total - @($skipped).Count - @($undetermined).Count

    return [pscustomobject]@{
        total               = $total
        executable          = $executable
        skipped             = @($skipped)
        undetermined        = @($undetermined)
        errors              = @($read.errors)
        executableSelectors = @($executableSelectors)
        executableLegs      = @($executableLegs)
    }
}

function Get-ChaosLegIdentity {
    <#
    .SYNOPSIS
        One leg's identity: which action, against which service-resolved target.

    .DESCRIPTION
        Counts alone cannot distinguish "action A runs against target T" from
        "action B runs against target T". The hash is a consent gate, so the
        identity it covers has to name both halves.
    #>
    param([AllowNull()][object]$Leg)

    if ($null -eq $Leg) { return '(unnamed action)::(unnamed leg)' }

    $action = [string](Get-ChaosPlanField -Node $Leg -Names @('action'))
    $selector = [string](Get-ChaosPlanField -Node $Leg -Names @('legSelector', 'resourceSelector', 'selector'))
    if ([string]::IsNullOrWhiteSpace($action)) { $action = '(unnamed action)' }
    if ([string]::IsNullOrWhiteSpace($selector)) { $selector = '(unnamed leg)' }
    return "$action::$selector"
}

# Bumped whenever the projection's meaning changes. The hash carries it as a
# prefix so a plan frozen by an older suite is REFUSED rather than silently
# reinterpreted against different semantics.
#
# v2 -> v3: v2's claim to cover "service-resolved target identities" was not
# true. Leg expansion read only `targets`/`selectors`/`resources`, so a live
# plan - which reports its resolved targets as `properties.targetResources[]`
# with a `fullyQualifiedIdentifier` - produced ONE null-target leg whose
# identity degraded to `<action>::<action>`. A v2 hash therefore says nothing
# about which resources the fault would hit, and two plans differing only in
# their target resource hash identically under it. v3 reads that list and hashes
# the fully-qualified identifiers, so a v2 digest cannot be compared against a
# v3 one and must be re-scoped and re-consented.
$script:ChaosEffectivePlanHashVersion = 3

function Get-ChaosEffectivePlanProjection {
    <#
    .SYNOPSIS
        The stable projection both scope and run hash.

    .DESCRIPTION
        Deliberately counts, sorted leg identities and the configuration body -
        not the platform's free-text skip reasons, which vary run to run for the
        same effective plan. Equality therefore means "the same actions execute
        against the same service-resolved targets, with the same fault
        parameters and the same configured duration".

        A leg identity names the action and the target's fully-qualified
        identifier when the plan reported one (`properties.targetResources[]` on
        the live shape), falling back to whatever selector the plan did carry.
        That fallback is why the projection also records `executable` and
        `total`: an identity that degraded to the action's own name is still
        counted, so a plan whose targets could not be read is visibly different
        from one whose targets were read and matched.

        Undetermined legs are part of the projection: a plan that became
        readable, or stopped being readable, is not the same plan. The
        configuration body carries the action URN, the fault parameters and the
        actual configured duration, so a plan re-frozen with a longer duration
        or a different parameter no longer matches.
    #>
    param(
        [Parameter(Mandatory)][object]$EffectiveLegs,
        [AllowNull()][object]$ConfigurationBody
    )

    return [ordered]@{
        version       = $script:ChaosEffectivePlanHashVersion
        total         = $EffectiveLegs.total
        executable    = $EffectiveLegs.executable
        executing     = @(@($EffectiveLegs.executableLegs) | ForEach-Object { Get-ChaosLegIdentity -Leg $_ } | Sort-Object)
        skipped       = @(@($EffectiveLegs.skipped) | ForEach-Object { Get-ChaosLegIdentity -Leg $_ } | Sort-Object)
        undetermined  = @(@($EffectiveLegs.undetermined) | ForEach-Object { Get-ChaosLegIdentity -Leg $_ } | Sort-Object)
        configuration = $(if ($null -eq $ConfigurationBody) { '(no configuration body)' } else { $ConfigurationBody })
    }
}

function Test-ChaosEffectivePlanHashCurrent {
    <#
    .SYNOPSIS
        Whether a frozen hash was produced by the current projection version.

    .DESCRIPTION
        A legacy hash is not "wrong", it is unreadable: nobody can say what a
        pre-version digest covered. Callers refuse it and ask for a re-scope
        rather than migrating it, because a silent migration would re-use consent
        that was given for a different, narrower description of the plan.

        This is not hypothetical bookkeeping. A v2 digest was computed without
        reading the service's resolved target list, so it could not distinguish
        two plans that hit different resources. Accepting one now, under v3
        semantics, would let consent given for "some plan" arm a run against a
        target nobody reviewed. Refusal costs a re-scope; acceptance costs the
        gate.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Hash)

    if ([string]::IsNullOrWhiteSpace($Hash)) { return $false }
    return $Hash.StartsWith("v$($script:ChaosEffectivePlanHashVersion):", [System.StringComparison]::Ordinal)
}

function Get-ChaosEffectivePlanHash {
    <#
    .SYNOPSIS
        The one effective-plan hash. Scope freezes it; run recomputes it from
        the SAME code path and refuses to start when they differ.

    .DESCRIPTION
        Covers the service-resolved target identities, the action identities,
        the fault parameters and the actual configured duration - the last two
        via the configuration body, which is the same payload the run sends.
        Target identities come from the plan's own resolved list
        (`properties.targetResources[].fullyQualifiedIdentifier` on the live
        shape), so the digest changes when the fault would land on a different
        resource. The returned value is version-prefixed so a hash frozen under
        older semantics is refused rather than compared.
    #>
    param(
        [AllowNull()][object]$ExecutionPlan,
        [AllowNull()][object]$ConfigurationBody
    )

    # A singleton pipeline container is not another execution plan. Normalize
    # only the outer container; the projection's own lists stay arrays.
    if ($ExecutionPlan -is [array] -and $ExecutionPlan.Count -eq 1) {
        $ExecutionPlan = $ExecutionPlan[0]
    }

    $legs = Resolve-ChaosEffectiveLeg -ExecutionPlan $ExecutionPlan
    $projection = Get-ChaosEffectivePlanProjection -EffectiveLegs $legs -ConfigurationBody $ConfigurationBody
    if ($projection -is [array] -and $projection.Count -eq 1) {
        $projection = $projection[0]
    }
    return "v$($script:ChaosEffectivePlanHashVersion):$(Get-ChaosDigest -InputObject $projection)"
}
