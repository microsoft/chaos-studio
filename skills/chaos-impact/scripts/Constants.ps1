<#
.SYNOPSIS
    Pinned API versions and tunable defaults for the chaos-impact skill.

.DESCRIPTION
    Centralises every Azure REST API version touched by the skill so version
    drift across the six Monitor surfaces (metrics, logs, activity log,
    alerts, service health, diagnostic settings) is a one-line update.

    Dot-source this file from any chaos-impact script:
        . "$PSScriptRoot/Constants.ps1"
#>

# ── Pinned API versions ─────────────────────────────────
# Diagnostic Settings — Microsoft.Insights/diagnosticSettings
$script:ChaosImpactApi_DiagnosticSettings = '2021-05-01-preview'

# Azure Monitor Metrics — Microsoft.Insights/metrics
$script:ChaosImpactApi_Metrics = '2024-02-01'

# Log Analytics Query — api.loganalytics.io
$script:ChaosImpactApi_LogAnalytics = 'v1'
$script:ChaosImpactEndpoint_LogAnalytics = 'https://api.loganalytics.io'

# Activity Log — Microsoft.Insights/eventtypes/management/values
$script:ChaosImpactApi_ActivityLog = '2015-04-01'

# Alerts Management — Microsoft.AlertsManagement/alerts (fallback 2018-05-05)
$script:ChaosImpactApi_AlertsManagement = '2023-05-01-preview'
$script:ChaosImpactApi_AlertsManagementFallback = '2018-05-05'

# Resource Health — Microsoft.ResourceHealth
$script:ChaosImpactApi_ResourceHealth = '2022-10-01'

# Chaos Studio ScenarioRun — Microsoft.Chaos/workspaces
$script:ChaosImpactApi_ChaosStudio = '2026-05-01-preview'

# Log Analytics Workspace resource — Microsoft.OperationalInsights/workspaces
# (used for the cheap reachability GET in Get-DiagnosticSettings).
$script:ChaosImpactApi_LogAnalyticsWorkspace = '2022-10-01'

# ── Tunable defaults ────────────────────────────────────
$script:ChaosImpactDefault_MaxResources       = 50
$script:ChaosImpactDefault_Buffer             = 'PT5M'
$script:ChaosImpactDefault_DiagThrottleLimit  = 4
$script:ChaosImpactDefault_StateSchemaVersion = 1

# ── Convenience getter ──────────────────────────────────
function Get-ChaosImpactConstants {
    <#
    .SYNOPSIS
        Returns the pinned API versions and defaults as an ordered hashtable.
    .DESCRIPTION
        Useful for tests and for emitting versions into the JSON sidecar.
    #>
    [CmdletBinding()]
    param()

    return [ordered]@{
        apiVersions = [ordered]@{
            diagnosticSettings       = $script:ChaosImpactApi_DiagnosticSettings
            metrics                  = $script:ChaosImpactApi_Metrics
            logAnalytics             = $script:ChaosImpactApi_LogAnalytics
            activityLog              = $script:ChaosImpactApi_ActivityLog
            alertsManagement         = $script:ChaosImpactApi_AlertsManagement
            alertsManagementFallback = $script:ChaosImpactApi_AlertsManagementFallback
            resourceHealth           = $script:ChaosImpactApi_ResourceHealth
            chaosStudio              = $script:ChaosImpactApi_ChaosStudio
            logAnalyticsWorkspace    = $script:ChaosImpactApi_LogAnalyticsWorkspace
        }
        endpoints = [ordered]@{
            logAnalytics = $script:ChaosImpactEndpoint_LogAnalytics
        }
        defaults = [ordered]@{
            maxResources       = $script:ChaosImpactDefault_MaxResources
            buffer             = $script:ChaosImpactDefault_Buffer
            diagThrottleLimit  = $script:ChaosImpactDefault_DiagThrottleLimit
            stateSchemaVersion = $script:ChaosImpactDefault_StateSchemaVersion
        }
    }
}
