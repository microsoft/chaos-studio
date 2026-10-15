# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    API-version pins for the chaos-study skill suite.

.DESCRIPTION
    One file, one pin per surface, so version drift is a one-line change.

    These values intentionally mirror the shipped
    `skills/chaos-impact/scripts/Constants.ps1`. They are declared here rather
    than dot-sourced from that file because it declares its pins with
    `$script:` scope, which does not survive a nested dot-source chain
    reliably. If the plugin later promotes a shared `scripts/Constants.ps1`,
    this file becomes a dot-source shim to it.

    Every version below is recorded in the sealed study manifest, so a study
    stays reproducible after the pins move.
#>

Set-StrictMode -Version Latest

$ChaosStudyApiVersions = [ordered]@{
    # Chaos Studio V2 - Microsoft.Chaos/workspaces, and the scenario,
    # scenario-configuration and scenario-run resources beneath a workspace.
    # This is the only Chaos control-plane surface this suite uses.
    chaosStudio              = '2026-05-01-preview'
    # Microsoft.Chaos/locations/{region}/actions - the live action inventory.
    # This suite ships no bundled list of faults; every action it can describe
    # is read from this endpoint at scope time and treated as authoritative.
    chaosActions             = '2026-05-01-preview'
    # Generic ARM resource read - used to resolve a scoped resource's region
    resources                = '2021-04-01'
    # Microsoft.Authorization role assignments - read-only before/after snapshots
    # around a permission repair, so a study can report what was actually granted
    # rather than what the service was asked to grant.
    roleAssignments          = '2022-04-01'
    # Azure Monitor metrics - Microsoft.Insights/metrics
    metrics                  = '2024-02-01'
    # Log Analytics query API
    logAnalytics             = 'v1'
    # Activity Log
    activityLog              = '2015-04-01'
    # Alerts Management, with the documented fallback
    alertsManagement         = '2023-05-01-preview'
    alertsManagementFallback = '2018-05-05'
    # Azure Monitor workspace (managed Prometheus)
    monitorWorkspace         = '2023-04-03'
    # Data collection rules - used to detect a Prometheus pipeline
    dataCollectionRules      = '2022-06-01'
    # Diagnostic settings
    diagnosticSettings       = '2021-05-01-preview'
}

$ChaosStudyEndpoints = [ordered]@{
    logAnalytics = 'https://api.loganalytics.io'
}

function Get-ChaosApiVersion {
    <#
    .SYNOPSIS
        Resolve a pinned api-version by name. Unknown names fail loudly so a
        typo can never silently fall back to some default version.
    #>
    param([Parameter(Mandatory)][string]$Name)
    if (-not $ChaosStudyApiVersions.Contains($Name)) {
        throw "Unknown api-version pin '$Name'. Known: $(($ChaosStudyApiVersions.Keys) -join ', ')"
    }
    return $ChaosStudyApiVersions[$Name]
}

function Get-ChaosApiVersionTable {
    <#
    .SYNOPSIS
        The full pin table, for the study manifest and the report appendix.
    #>
    $copy = [ordered]@{}
    foreach ($key in $ChaosStudyApiVersions.Keys) { $copy[$key] = $ChaosStudyApiVersions[$key] }
    return $copy
}

function Get-ChaosEndpoint {
    param([Parameter(Mandatory)][string]$Name)
    if (-not $ChaosStudyEndpoints.Contains($Name)) {
        throw "Unknown endpoint '$Name'. Known: $(($ChaosStudyEndpoints.Keys) -join ', ')"
    }
    return $ChaosStudyEndpoints[$Name]
}
