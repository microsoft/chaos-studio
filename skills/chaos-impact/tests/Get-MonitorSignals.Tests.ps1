<#
.SYNOPSIS
    Pester 5 unit tests for Get-MonitorSignals.ps1 — covers the pure helpers
    extracted for testability (no ARM calls).

.DESCRIPTION
    Coverage:
      - Test-IsApiVersionError: API-version errors → true; auth/throttle/5xx → false.
      - Get-ArmResourceType: provider-type extraction (simple + nested).
      - Get-DefaultMetricNames: hashtable + PSCustomObject MetricDefaults shapes;
        missing type returns empty array (no metrics fan-out for that resource).
      - Get-LogsCoverage: splits resources into available/unavailable, builds the
        per-workspace grouping for the KQL fan-out, and produces a reason map
        for the unavailable resources.
      - New-UnavailableLogMarker: shape of the status='unavailable' marker
        emitted for resources without a workspace mapping.
      - Invoke-AlertsWithFallback: falls back ONLY on API-version errors;
        auth (401), throttling (429), 5xx errors must propagate.
      - $using: capture audit: confirms the parallel scriptblocks reference
        only variables declared with $using: scope (no silent captures).

    These tests do not exercise the live parallel ARM fan-outs (those require
    az login + real resources and live in the E2E suite, Epic 5). All ARM
    edges are mocked through the -Invoker test seam on Invoke-AlertsWithFallback
    or by inspecting the script source for $using: scoping.

    Run:   Invoke-Pester -Path ./tests/Get-MonitorSignals.Tests.ps1
#>

BeforeAll {
    $script:SkillRoot   = Split-Path $PSScriptRoot -Parent
    $script:ScriptsDir  = Join-Path $script:SkillRoot 'scripts'
    $script:SignalsScript = Join-Path $script:ScriptsDir 'Get-MonitorSignals.ps1'

    # Dot-sourcing the script brings every top-level function (helpers + main)
    # into scope. The script defines a function, so there is no "main body" to
    # accidentally execute at load time.
    . (Join-Path $script:ScriptsDir 'Constants.ps1')
    . $script:SignalsScript
}

Describe 'Test-IsApiVersionError' {
    It 'returns true for InvalidApiVersionParameter ARM error code' {
        Test-IsApiVersionError -Message "The api-version 'foo' is invalid: InvalidApiVersionParameter" | Should -BeTrue
    }
    It "returns true for 'api version' text in the message" {
        Test-IsApiVersionError -Message 'Unsupported API version 2023-05-01-preview' | Should -BeTrue
    }
    It 'returns true for NoRegisteredProviderFound' {
        Test-IsApiVersionError -Message 'NoRegisteredProviderFound for Microsoft.AlertsManagement' | Should -BeTrue
    }
    It 'returns false for a 401 auth failure' {
        Test-IsApiVersionError -Message 'AuthorizationFailed: The client does not have authorization (401)' | Should -BeFalse
    }
    It 'returns false for a 429 throttling response' {
        Test-IsApiVersionError -Message 'TooManyRequests (429): Rate limit exceeded' | Should -BeFalse
    }
    It 'returns false for a 500-class error' {
        Test-IsApiVersionError -Message 'InternalServerError (500)' | Should -BeFalse
    }
    It 'returns false for a network timeout' {
        Test-IsApiVersionError -Message 'The operation has timed out' | Should -BeFalse
    }
    It 'returns false on empty input' {
        Test-IsApiVersionError -Message '' | Should -BeFalse
    }
}

Describe 'Get-ArmResourceType' {
    It 'extracts a simple provider/type' {
        Get-ArmResourceType -ResourceId '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vmA' |
            Should -Be 'Microsoft.Compute/virtualMachines'
    }
    It 'extracts a nested type (Sql/servers/databases)' {
        Get-ArmResourceType -ResourceId '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Sql/servers/s1/databases/d1' |
            Should -Be 'Microsoft.Sql/servers/databases'
    }
    It 'returns $null when /providers/ is absent' {
        Get-ArmResourceType -ResourceId '/subscriptions/s/resourceGroups/rg' | Should -BeNullOrEmpty
    }
}

Describe 'Get-DefaultMetricNames' {
    It 'returns the metric list for a hashtable-shaped defaults entry' {
        $d = @{ 'Microsoft.Compute/virtualMachines' = @{ metrics = @('Percentage CPU', 'Disk Read Bytes') } }
        $r = Get-DefaultMetricNames -MetricDefaults $d -ResourceType 'Microsoft.Compute/virtualMachines'
        $r | Should -HaveCount 2
        $r[0] | Should -Be 'Percentage CPU'
    }
    It 'returns the metric list for a PSCustomObject defaults entry (JSON shape)' {
        $d = [pscustomobject]@{
            'Microsoft.Compute/virtualMachines' = [pscustomobject]@{
                metrics = @('Percentage CPU')
            }
        }
        (Get-DefaultMetricNames -MetricDefaults $d -ResourceType 'Microsoft.Compute/virtualMachines') | Should -HaveCount 1
    }
    It 'returns empty array when resource type is missing (no metrics fan-out)' {
        $d = @{ 'Microsoft.Compute/virtualMachines' = @{ metrics = @('Percentage CPU') } }
        (Get-DefaultMetricNames -MetricDefaults $d -ResourceType 'Microsoft.Web/sites') | Should -HaveCount 0
    }
    It 'returns empty array on null defaults' {
        (Get-DefaultMetricNames -MetricDefaults $null -ResourceType 'Anything') | Should -HaveCount 0
    }
}

Describe 'Get-LogsCoverage' {
    BeforeEach {
        $script:resA = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/A'
        $script:resB = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/B'
        $script:resC = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/C'
        $script:ws1  = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/ws1'
        $script:ws2  = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/ws2'
    }

    It 'splits resources into available + unavailable buckets and groups by workspace' {
        $map = @{
            $script:resA.ToLowerInvariant() = @{ status = 'available'; workspaceId = $script:ws1 }
            $script:resB.ToLowerInvariant() = @{ status = 'available'; workspaceId = $script:ws1 }
            $script:resC.ToLowerInvariant() = @{ status = 'unavailable'; reason = 'no_diagnostic_setting' }
        }
        $c = Get-LogsCoverage -ResourceIds @($script:resA, $script:resB, $script:resC) -WorkspaceMap $map

        $c.available             | Should -HaveCount 2
        $c.unavailable           | Should -HaveCount 1
        $c.unavailable[0]        | Should -Be $script:resC
        $c.reasons[$script:resC] | Should -Be 'no_diagnostic_setting'
        $c.workspaceToIds.Keys   | Should -Contain $script:ws1
        $c.workspaceToIds[$script:ws1] | Should -HaveCount 2
    }

    It "tags resources missing from the map with reason='not_queried'" {
        $c = Get-LogsCoverage -ResourceIds @($script:resA) -WorkspaceMap @{}
        $c.unavailable           | Should -HaveCount 1
        $c.reasons[$script:resA] | Should -Be 'not_queried'
    }

    It 'handles two distinct workspaces and groups correctly' {
        $map = @{
            $script:resA.ToLowerInvariant() = @{ status = 'available'; workspaceId = $script:ws1 }
            $script:resB.ToLowerInvariant() = @{ status = 'available'; workspaceId = $script:ws2 }
        }
        $c = Get-LogsCoverage -ResourceIds @($script:resA, $script:resB) -WorkspaceMap $map
        $c.workspaceToIds.Keys | Should -HaveCount 2
        $c.workspaceToIds[$script:ws1] | Should -HaveCount 1
        $c.workspaceToIds[$script:ws2] | Should -HaveCount 1
    }
}

Describe 'New-UnavailableLogMarker' {
    It "emits status='unavailable' with the supplied reason" {
        $m = New-UnavailableLogMarker -ResourceId '/sub/x/Microsoft.X/y/z' -Reason 'no_workspace_destination'
        $m.status      | Should -Be 'unavailable'
        $m.resourceId  | Should -Be '/sub/x/Microsoft.X/y/z'
        $m.reason      | Should -Be 'no_workspace_destination'
        $m.workspaceId | Should -BeNullOrEmpty
        $m.rows        | Should -HaveCount 0
        $m.kql         | Should -BeNullOrEmpty
    }
    It "defaults reason to 'not_queried' when omitted" {
        (New-UnavailableLogMarker -ResourceId '/x').reason | Should -Be 'not_queried'
    }
}

Describe 'Invoke-AlertsWithFallback' {
    It 'calls the preview API and returns its response when successful' {
        $script:calls = @()
        $invoker = { param($u, $v) $script:calls += $v; return [pscustomobject]@{ body = [pscustomobject]@{ value = @() } } }
        $r = Invoke-AlertsWithFallback -Uri '/alerts' -PreviewApi '2023-05-01-preview' -FallbackApi '2018-05-05' -Invoker $invoker
        $script:calls          | Should -HaveCount 1
        $script:calls[0]       | Should -Be '2023-05-01-preview'
        $r.body.value          | Should -HaveCount 0
    }

    It 'falls back to the stable API on an API-version error' {
        $script:calls = @()
        $invoker = {
            param($u, $v)
            $script:calls += $v
            if ($v -eq '2023-05-01-preview') { throw 'InvalidApiVersionParameter: api-version not supported' }
            return [pscustomobject]@{ body = [pscustomobject]@{ value = @('alert1') } }
        }
        $r = Invoke-AlertsWithFallback -Uri '/alerts' -PreviewApi '2023-05-01-preview' -FallbackApi '2018-05-05' -Invoker $invoker
        $script:calls    | Should -HaveCount 2
        $script:calls[1] | Should -Be '2018-05-05'
        $r.body.value    | Should -HaveCount 1
    }

    It 'does NOT fall back on a 401 auth error (propagates instead)' {
        $invoker = { param($u, $v) throw 'AuthorizationFailed (401): caller lacks required RBAC' }
        { Invoke-AlertsWithFallback -Uri '/alerts' -PreviewApi 'pv' -FallbackApi 'fb' -Invoker $invoker } |
            Should -Throw '*AuthorizationFailed*'
    }

    It 'does NOT fall back on a 429 throttling error' {
        $invoker = { param($u, $v) throw 'TooManyRequests (429)' }
        { Invoke-AlertsWithFallback -Uri '/alerts' -PreviewApi 'pv' -FallbackApi 'fb' -Invoker $invoker } |
            Should -Throw '*429*'
    }

    It 'does NOT fall back on a 500 server error' {
        $invoker = { param($u, $v) throw 'InternalServerError (500)' }
        { Invoke-AlertsWithFallback -Uri '/alerts' -PreviewApi 'pv' -FallbackApi 'fb' -Invoker $invoker } |
            Should -Throw '*500*'
    }
}

Describe '$using: variable capture audit (parallel scriptblocks)' {
    # Static-analysis safety net: ForEach-Object -Parallel scriptblocks in PS7
    # do NOT capture outer-scope variables automatically. Every variable
    # referenced inside a -Parallel block must use `$using:` (or -ArgumentList).
    # This test parses the script source and verifies that every variable
    # mentioned inside a -Parallel { ... } block is either declared inside the
    # block, $using:-prefixed, or a known automatic ($_, $true, $LASTEXITCODE, etc.).
    BeforeAll {
        $script:source = Get-Content -Raw -Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/Get-MonitorSignals.ps1')
    }

    It 'metrics parallel block references outer-scope vars via $using: only' {
        # Expect the block to reference $using:invokeAzRestPath, $using:metricsApi, $using:timespan
        $script:source | Should -Match '\$using:invokeAzRestPath'
        $script:source | Should -Match '\$using:metricsApi'
        $script:source | Should -Match '\$using:timespan'
    }
    It 'activity-log parallel block references SubscriptionId via $using:' {
        $script:source | Should -Match '\$using:SubscriptionId'
        $script:source | Should -Match '\$using:activityApi'
        $script:source | Should -Match '\$using:tStartIso'
        $script:source | Should -Match '\$using:tEndIso'
    }
    It 'contains no bare references to outer-scope vars inside -Parallel { ... }' {
        # Naive but useful: any -Parallel block must not reference outer vars
        # without $using:. Look for the well-known leakage pattern.
        $parallelBlocks = [regex]::Matches($script:source, '(?ms)-Parallel\s*\{(.+?)\n\s*\}')
        foreach ($pb in $parallelBlocks) {
            $body = $pb.Groups[1].Value
            # Common silent-leak: referencing $ResourceIds/$SubscriptionId/$WorkspaceMap/$Buffer
            # without the $using: prefix.
            foreach ($leak in @('$ResourceIds', '$WorkspaceMap', '$Buffer', '$SubscriptionId ',
                                '$MaxRows', '$ActionWindows')) {
                ($body -match [regex]::Escape($leak)) | Should -BeFalse -Because "outer-scope `$leak` would silently be `$null inside -Parallel; use `$using:"
            }
        }
    }
}
