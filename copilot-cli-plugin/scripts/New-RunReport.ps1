<#
.SYNOPSIS
    Generate a structured, self-contained HTML report for a Chaos ScenarioRun.
.DESCRIPTION
    Consumes a ScenarioRun resource body (the full JSON returned by
    GET .../scenarios/{name}/runs/{id}) plus optional pipeline state
    and renders a single-file HTML document with:
      - status header + badge
      - summary cards (scenario, workspace, run id, identity, duration)
      - parameters table (from state.setup.configuration)
      - targeted resources list
      - SVG action timeline (Gantt-style)
      - action details table
      - errors section
      - collapsible raw JSON
    Output path defaults to
      ${SESSION_DIR}\reports\run-<runId>-<timestampUtc>.html
.PARAMETER RunBody
    The .properties-containing run body object (result of Invoke-AzRest on
    the run resource, i.e. $runResp.body). REQUIRED.
.PARAMETER State
    Optional full pipeline state (Read-State result) used to enrich the
    report with parameters, MSI, scopes, etc.
.PARAMETER OutputPath
    Optional full path. Defaults to reports\ next to $env:STARTCHAOS_STATE_PATH.
.OUTPUTS
    Absolute path to the written .html file.
#>
function New-RunReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $RunBody,
        [Parameter()] $State,
        [Parameter()] [string] $OutputPath
    )

    $ErrorActionPreference = 'Stop'

    # ── Resolve output path ──────────────────────────────
    if (-not $OutputPath) {
        $baseDir = if ($env:STARTCHAOS_STATE_PATH) {
            Split-Path -Parent $env:STARTCHAOS_STATE_PATH
        } else {
            (Get-Location).Path
        }
        $reportsDir = Join-Path $baseDir 'reports'
        if (-not (Test-Path $reportsDir)) {
            New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
        }
        $runId = if ($RunBody.name) { $RunBody.name } else { 'unknown' }
        $ts = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
        $OutputPath = Join-Path $reportsDir "run-$runId-$ts.html"
    }

    # ── Extract core fields ──────────────────────────────
    $p = $RunBody.properties
    $runId = $RunBody.name
    $runArmId = $RunBody.id
    $scenarioName = $p.scenarioName
    $configName = $p.scenarioConfigurationName
    $workspaceName = $p.workspaceName
    $status = $p.status
    $startStr = $p.startTime
    $endStr = $p.endTime
    $msi = $p.managedIdentityPrincipalId
    $summary = @($p.scenarioRunSummary)
    $errors = @($p.errors)
    $resources = @($p.resources)

    # Compute durations
    $startDt = $null; $endDt = $null; $totalMs = 0
    if ($startStr) { $startDt = [datetime]::Parse($startStr).ToUniversalTime() }
    if ($endStr)   { $endDt   = [datetime]::Parse($endStr).ToUniversalTime() }
    if ($startDt -and $endDt) { $totalMs = [int]($endDt - $startDt).TotalMilliseconds }

    # Status styling
    $statusClass = switch ($status) {
        'Succeeded' { 'ok' }
        'Failed'    { 'err' }
        'Canceled'  { 'warn' }
        default     { 'info' }
    }
    $statusEmoji = switch ($status) {
        'Succeeded' { '✅' }
        'Failed'    { '❌' }
        'Canceled'  { '⚠️' }
        default     { '❔' }
    }

    # ── Parse scenarioRunJson (contains action params, target resources) ──
    $scenarioRunPlan = $null
    if ($p.scenarioRunJson) {
        try { $scenarioRunPlan = $p.scenarioRunJson | ConvertFrom-Json -ErrorAction Stop } catch {}
    }

    # ── Collect action rows + timeline data ─────────────
    $actionRows = @()
    $timelineItems = @()
    $rangeStartMs = $null; $rangeEndMs = $null

    foreach ($s in $summary) {
        $sStart = $null; $sEnd = $null
        if ($s.startedAt)   { $sStart = [datetime]::Parse($s.startedAt).ToUniversalTime() }
        if ($s.completedAt) { $sEnd   = [datetime]::Parse($s.completedAt).ToUniversalTime() }

        $durMs = 0
        if ($sStart -and $sEnd) { $durMs = [int]($sEnd - $sStart).TotalMilliseconds }

        $actionUrn = $s.actionUrn
        # Pull richer detail from scenarioRunJson actions dict
        $actionDetail = $null
        if ($scenarioRunPlan -and $scenarioRunPlan.actions) {
            $actionDetail = $scenarioRunPlan.actions.$actionUrn
        }
        $faultUrn = if ($actionDetail) { $actionDetail.properties.faultUrn } else { $null }
        $actionType = if ($actionDetail) { $actionDetail.type } else { $null }
        $displayName = if ($actionDetail -and $actionDetail.displayName) { $actionDetail.displayName } else { $actionUrn }
        $duration = if ($actionDetail) { $actionDetail.stopCondition.duration } else { $null }

        $actionRows += [pscustomobject]@{
            Urn        = $actionUrn
            Display    = $displayName
            Type       = $actionType
            FaultUrn   = $faultUrn
            State      = $s.state
            StartedAt  = $sStart
            CompletedAt = $sEnd
            DurationMs = $durMs
            Duration   = $duration
            Resources  = @($s.resources)
        }

        if ($sStart -and $sEnd) {
            $timelineItems += [pscustomobject]@{
                Urn = $actionUrn; Display = $displayName; State = $s.state
                Start = $sStart; End = $sEnd
            }
            if (-not $rangeStartMs -or $sStart -lt $rangeStartMs) { $rangeStartMs = $sStart }
            if (-not $rangeEndMs   -or $sEnd   -gt $rangeEndMs)   { $rangeEndMs   = $sEnd }
        }
    }

    # Expand timeline range to cover whole run if we have it
    if ($startDt -and (-not $rangeStartMs -or $startDt -lt $rangeStartMs)) { $rangeStartMs = $startDt }
    if ($endDt   -and (-not $rangeEndMs   -or $endDt   -gt $rangeEndMs))   { $rangeEndMs   = $endDt }

    # ── Build SVG timeline ──────────────────────────────
    $svgTimeline = ''
    if ($timelineItems.Count -gt 0 -and $rangeStartMs -and $rangeEndMs) {
        $totalSpanMs = [math]::Max(1, [int]($rangeEndMs - $rangeStartMs).TotalMilliseconds)
        $chartWidth = 900
        $labelWidth = 260
        $barAreaWidth = $chartWidth - $labelWidth - 20
        $rowHeight = 34
        $chartHeight = ($timelineItems.Count * $rowHeight) + 60

        $svgParts = @()
        $svgParts += "<svg viewBox='0 0 $chartWidth $chartHeight' xmlns='http://www.w3.org/2000/svg' class='timeline-svg'>"

        # Grid lines (4 divisions)
        for ($i = 0; $i -le 4; $i++) {
            $x = $labelWidth + ($barAreaWidth * $i / 4)
            $svgParts += "<line x1='$x' y1='20' x2='$x' y2='$(($chartHeight - 30))' stroke='#e5e7eb' stroke-dasharray='2,2' />"
            $pctMs = [int]($totalSpanMs * $i / 4)
            $label = if ($pctMs -lt 1000) { "${pctMs}ms" } else { "$([math]::Round($pctMs/1000,1))s" }
            $svgParts += "<text x='$x' y='15' text-anchor='middle' class='tick'>$label</text>"
        }

        $row = 0
        foreach ($it in $timelineItems) {
            $offsetMs = [int]($it.Start - $rangeStartMs).TotalMilliseconds
            $lenMs    = [math]::Max(2, [int]($it.End - $it.Start).TotalMilliseconds)
            $x = $labelWidth + ($barAreaWidth * $offsetMs / $totalSpanMs)
            $w = [math]::Max(4, $barAreaWidth * $lenMs / $totalSpanMs)
            $y = 30 + ($row * $rowHeight)

            $barClass = switch ($it.State) {
                'Succeeded' { 'bar-ok' }
                'Failed'    { 'bar-err' }
                'Canceled'  { 'bar-warn' }
                default     { 'bar-info' }
            }
            $label = $it.Display
            if ($label.Length -gt 34) { $label = $label.Substring(0, 33) + '…' }
            $svgParts += "<text x='10' y='$($y + 16)' class='row-label'>$([System.Web.HttpUtility]::HtmlEncode($label))</text>"
            $svgParts += "<rect x='$x' y='$y' width='$w' height='22' rx='3' class='$barClass' />"
            $svgParts += "<text x='$($x + $w + 6)' y='$($y + 16)' class='row-dur'>$([math]::Round($lenMs/1000,2))s</text>"
            $row++
        }

        $svgParts += "</svg>"
        $svgTimeline = $svgParts -join "`n"
    } else {
        $svgTimeline = "<div class='empty'>No timeline data available.</div>"
    }

    # ── Helper to HTML-encode ────────────────────────────
    Add-Type -AssemblyName System.Web -ErrorAction SilentlyContinue
    function _he([string]$s) {
        if ($null -eq $s) { return '' }
        return [System.Web.HttpUtility]::HtmlEncode($s)
    }

    # ── Summary + parameter data from state ──────────────
    $subId = ''
    $rgName = ''
    $workspaceScopes = @()
    $configParams = @()
    if ($State) {
        if ($State.context) {
            $subId = $State.context.subscriptionId
            $rgName = $State.context.resourceGroup
        }
        if ($State.workspace -and $State.workspace.scopes) {
            $workspaceScopes = @($State.workspace.scopes)
        }
        if ($State.setup -and $State.setup.configuration -and $State.setup.configuration.parameters) {
            $configParams = @($State.setup.configuration.parameters)
        }
    }

    # ── Build HTML ───────────────────────────────────────
    $totalDur = if ($totalMs -gt 0) { "$([math]::Round($totalMs/1000,2))s" } else { '—' }

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine('<!DOCTYPE html>')
    [void]$sb.AppendLine('<html lang="en"><head><meta charset="UTF-8">')
    [void]$sb.AppendLine("<title>Chaos Run Report — $([System.Web.HttpUtility]::HtmlEncode($scenarioName))</title>")
    [void]$sb.AppendLine(@'
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;margin:0;background:#f8fafc;color:#0f172a;line-height:1.5}
.container{max-width:1200px;margin:0 auto;padding:24px}
.hdr{background:linear-gradient(135deg,#0ea5e9 0%,#6366f1 100%);color:#fff;padding:32px 28px;border-radius:12px;margin-bottom:24px;box-shadow:0 4px 12px rgba(0,0,0,.08)}
.hdr h1{margin:0 0 8px 0;font-size:28px;font-weight:600}
.hdr .sub{opacity:.9;font-size:14px}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:600;font-size:13px;margin-left:12px;vertical-align:middle}
.badge.ok{background:#10b981;color:#fff}
.badge.err{background:#ef4444;color:#fff}
.badge.warn{background:#f59e0b;color:#fff}
.badge.info{background:#64748b;color:#fff}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.card{background:#fff;padding:16px 18px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #e5e7eb}
.card .label{color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
.card .value{font-size:15px;font-weight:500;word-break:break-word}
.card.metric .value{font-size:22px;color:#0ea5e9}
section{background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #e5e7eb}
section h2{margin:0 0 16px 0;font-size:18px;font-weight:600;color:#0f172a;display:flex;align-items:center;gap:8px}
section h2::before{content:"";width:4px;height:20px;background:#0ea5e9;border-radius:2px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top}
th{color:#64748b;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.3px;background:#f8fafc}
tr:last-child td{border-bottom:none}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px;color:#0f172a;word-break:break-all}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
.pill.ok{background:#d1fae5;color:#065f46}
.pill.err{background:#fee2e2;color:#991b1b}
.pill.warn{background:#fef3c7;color:#92400e}
.pill.info{background:#e0e7ff;color:#3730a3}
.empty{color:#94a3b8;font-style:italic;padding:20px;text-align:center}
.timeline-svg{width:100%;height:auto;background:#fafafa;border-radius:6px}
.timeline-svg .tick{font-size:10px;fill:#64748b;font-family:inherit}
.timeline-svg .row-label{font-size:12px;fill:#0f172a;font-family:inherit}
.timeline-svg .row-dur{font-size:11px;fill:#64748b;font-family:inherit}
.timeline-svg .bar-ok{fill:#10b981}
.timeline-svg .bar-err{fill:#ef4444}
.timeline-svg .bar-warn{fill:#f59e0b}
.timeline-svg .bar-info{fill:#0ea5e9}
.err-box{background:#fef2f2;border-left:4px solid #ef4444;padding:12px 16px;border-radius:4px;margin-bottom:10px}
.err-box .code{font-weight:600;color:#991b1b;font-size:13px}
.err-box .msg{margin-top:4px;font-size:14px}
details{background:#f8fafc;padding:12px 16px;border-radius:6px;border:1px solid #e5e7eb}
details summary{cursor:pointer;font-weight:600;color:#475569}
details[open] summary{margin-bottom:12px}
pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:6px;overflow:auto;font-size:12px;max-height:480px}
.footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb}
.resource-chip{display:inline-block;background:#e0e7ff;color:#3730a3;padding:4px 10px;border-radius:4px;font-size:12px;font-family:ui-monospace,monospace;margin:2px;word-break:break-all}
</style>
'@)
    [void]$sb.AppendLine('</head><body><div class="container">')

    # ── Header ──────────────────────────────────────────
    [void]$sb.AppendLine("<div class='hdr'>")
    [void]$sb.AppendLine("  <h1>$statusEmoji Chaos Scenario Report <span class='badge $statusClass'>$(_he $status)</span></h1>")
    [void]$sb.AppendLine("  <div class='sub'><strong>$(_he $scenarioName)</strong> · configuration <code style='background:rgba(255,255,255,.2);color:#fff'>$(_he $configName)</code></div>")
    [void]$sb.AppendLine("  <div class='sub' style='margin-top:6px'>Run ID <code style='background:rgba(255,255,255,.2);color:#fff'>$(_he $runId)</code></div>")
    [void]$sb.AppendLine("</div>")

    # ── Summary cards ──────────────────────────────────
    [void]$sb.AppendLine("<div class='cards'>")
    [void]$sb.AppendLine("<div class='card metric'><div class='label'>Duration</div><div class='value'>$totalDur</div></div>")
    [void]$sb.AppendLine("<div class='card metric'><div class='label'>Actions</div><div class='value'>$($summary.Count)</div></div>")
    $failedCount = @($summary | Where-Object { $_.state -eq 'Failed' }).Count
    [void]$sb.AppendLine("<div class='card metric'><div class='label'>Failed Actions</div><div class='value' style='color:$(if($failedCount -gt 0){'#ef4444'}else{'#10b981'})'>$failedCount</div></div>")
    [void]$sb.AppendLine("<div class='card metric'><div class='label'>Errors</div><div class='value' style='color:$(if($errors.Count -gt 0){'#ef4444'}else{'#10b981'})'>$($errors.Count)</div></div>")
    [void]$sb.AppendLine("</div>")

    # ── Details section ────────────────────────────────
    [void]$sb.AppendLine("<section><h2>Details</h2>")
    [void]$sb.AppendLine("<table>")
    [void]$sb.AppendLine("<tr><th>Scenario</th><td>$(_he $scenarioName)</td></tr>")
    [void]$sb.AppendLine("<tr><th>Configuration</th><td><code>$(_he $configName)</code></td></tr>")
    [void]$sb.AppendLine("<tr><th>Workspace</th><td>$(_he $workspaceName)</td></tr>")
    if ($subId)  { [void]$sb.AppendLine("<tr><th>Subscription</th><td><code>$(_he $subId)</code></td></tr>") }
    if ($rgName) { [void]$sb.AppendLine("<tr><th>Resource Group</th><td><code>$(_he $rgName)</code></td></tr>") }
    [void]$sb.AppendLine("<tr><th>Run ARM ID</th><td><code>$(_he $runArmId)</code></td></tr>")
    [void]$sb.AppendLine("<tr><th>Execution Identity</th><td><code>$(_he $msi)</code></td></tr>")
    if ($startStr) { [void]$sb.AppendLine("<tr><th>Started</th><td>$(_he $startStr)</td></tr>") }
    if ($endStr)   { [void]$sb.AppendLine("<tr><th>Ended</th><td>$(_he $endStr)</td></tr>") }
    [void]$sb.AppendLine("</table></section>")

    # ── Parameters ─────────────────────────────────────
    if ($configParams.Count -gt 0) {
        [void]$sb.AppendLine("<section><h2>Parameters</h2><table><tr><th>Key</th><th>Value</th></tr>")
        foreach ($pr in $configParams) {
            [void]$sb.AppendLine("<tr><td><code>$(_he $pr.key)</code></td><td>$(_he $pr.value)</td></tr>")
        }
        [void]$sb.AppendLine("</table></section>")
    }

    # ── Timeline ───────────────────────────────────────
    [void]$sb.AppendLine("<section><h2>Action Timeline</h2>$svgTimeline</section>")

    # ── Actions table ──────────────────────────────────
    if ($actionRows.Count -gt 0) {
        [void]$sb.AppendLine("<section><h2>Actions</h2><table>")
        [void]$sb.AppendLine("<tr><th>Action</th><th>Type</th><th>State</th><th>Fault URN</th><th>Started</th><th>Completed</th><th>Duration</th><th>Resources</th></tr>")
        foreach ($a in $actionRows) {
            $pillClass = switch ($a.State) { 'Succeeded' {'ok'} 'Failed' {'err'} 'Canceled' {'warn'} default {'info'} }
            $durStr = if ($a.DurationMs -gt 0) { "$([math]::Round($a.DurationMs/1000,2))s" } else { '—' }
            $startStrA = if ($a.StartedAt)   { $a.StartedAt.ToString('HH:mm:ss.fff') } else { '—' }
            $endStrA   = if ($a.CompletedAt) { $a.CompletedAt.ToString('HH:mm:ss.fff') } else { '—' }
            $resList = ($a.Resources | ForEach-Object { "<span class='resource-chip'>$(_he ($_.id -split '/' | Select-Object -Last 1))</span>" }) -join ' '
            [void]$sb.AppendLine("<tr><td><strong>$(_he $a.Display)</strong><br><code style='font-size:11px'>$(_he $a.Urn)</code></td><td>$(_he $a.Type)</td><td><span class='pill $pillClass'>$(_he $a.State)</span></td><td><code style='font-size:11px'>$(_he $a.FaultUrn)</code></td><td>$startStrA</td><td>$endStrA</td><td>$durStr</td><td>$resList</td></tr>")
        }
        [void]$sb.AppendLine("</table></section>")
    }

    # ── Targeted resources ─────────────────────────────
    if ($resources.Count -gt 0) {
        [void]$sb.AppendLine("<section><h2>Targeted Resources</h2>")
        foreach ($r in $resources) {
            [void]$sb.AppendLine("<div class='resource-chip' style='display:block;margin:4px 0'>$(_he $r.id)</div>")
        }
        [void]$sb.AppendLine("</section>")
    }

    # ── Errors ─────────────────────────────────────────
    if ($errors.Count -gt 0) {
        [void]$sb.AppendLine("<section><h2>Errors</h2>")
        foreach ($e in $errors) {
            [void]$sb.AppendLine("<div class='err-box'><div class='code'>$(_he $e.errorCode)</div><div class='msg'>$(_he $e.errorMessage)</div></div>")
        }
        [void]$sb.AppendLine("</section>")
    }

    # ── Workspace scopes ───────────────────────────────
    if ($workspaceScopes.Count -gt 0) {
        [void]$sb.AppendLine("<section><h2>Workspace Scopes</h2>")
        foreach ($sc in $workspaceScopes) {
            [void]$sb.AppendLine("<div class='resource-chip' style='display:block;margin:4px 0'>$(_he $sc)</div>")
        }
        [void]$sb.AppendLine("</section>")
    }

    # ── Raw JSON ───────────────────────────────────────
    $rawJson = $RunBody | ConvertTo-Json -Depth 20
    [void]$sb.AppendLine("<section><h2>Raw Run JSON</h2><details><summary>Show / hide raw payload</summary><pre>$(_he $rawJson)</pre></details></section>")

    [void]$sb.AppendLine("<div class='footer'>Generated $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')) by startchaos plugin</div>")
    [void]$sb.AppendLine("</div></body></html>")

    # ── Write file ──────────────────────────────────────
    $sb.ToString() | Set-Content -Path $OutputPath -Encoding UTF8
    return (Resolve-Path $OutputPath).Path
}
