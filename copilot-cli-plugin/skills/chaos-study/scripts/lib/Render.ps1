<#
.SYNOPSIS
    Presentation fallbacks, so that the study suite renders its own output and
    never depends on an ambient host for one.

.DESCRIPTION
    The skills in this suite call Write-Card, Write-Table and Write-Error-Card
    to present their results. Those functions are provided by the Copilot CLI
    host. When a script is run directly - from a clean pwsh, from a packaged
    copy, from CI, from another agent's shell - they are simply not there, and
    an unguarded call becomes a CommandNotFoundException.

    That failure mode is the reason this file exists. Rendering is cosmetic:
    it says what happened, it does not make it happen. A study that has already
    injected a fault, or a cleanup that has already deleted a configuration,
    must not be reported as a crash because the terminal could not draw a box.
    The work was done; losing the description of it is the smaller harm, and
    losing the exit code as well is the larger one.

    Two rules follow from that, and they are the whole design:

      1. The host wins. If a renderer already exists - because we are running
         inside the CLI, or because another component defined one first - it is
         left exactly as it is. We define only what is missing. Replacing a
         host's renderer with ours would degrade output in the one environment
         that renders it best, and would do so silently.

      2. Nothing here throws. Each renderer wraps its body so that a malformed
         table row, an unprintable character or a serialisation failure degrades
         to plain text rather than propagating an error into a caller that is
         part-way through a fault injection.

    The fallbacks are deliberately plain markdown. They are meant to be
    readable in a bare terminal and in a log file, not to imitate the host.
#>

Set-StrictMode -Version Latest

function Write-ChaosRenderLine {
    <#
    .SYNOPSIS
        Emit one presentation line on the host stream.

    .DESCRIPTION
        Write-Host, not Write-Output, for the same reason Write-ChaosStudyFailure
        uses it: these helpers are called from functions whose success stream is
        routinely piped or discarded, and presentation that can be swallowed by
        a caller's pipeline is presentation that will eventually go missing at
        the worst moment.
    #>
    param([AllowEmptyString()][AllowNull()][string]$Text)
    try { Write-Host ([string]$Text) } catch { }
}

function ConvertTo-ChaosRenderScalar {
    <#
    .SYNOPSIS
        Render one cell value as a single line of text.

    .DESCRIPTION
        Null becomes an empty cell rather than the string "null": a table is a
        summary, and an absent value shown as blank is honest, whereas inventing
        a word for it is not. Collections are joined so that a row never breaks
        across lines and misaligns the table.
    #>
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return '' }
    try {
        if ($Value -is [string]) { return $Value }
        if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
        if ($Value -is [System.Collections.IEnumerable]) {
            $parts = @()
            foreach ($item in $Value) { $parts += [string]$item }
            return ($parts -join ', ')
        }
        return [string]$Value
    }
    catch { return '' }
}

if (-not (Get-Command -Name 'Write-Card' -ErrorAction SilentlyContinue)) {
    # Recorded so that callers which already have their own markdown fallback -
    # Write-ChaosStudyCard does - can keep using it rather than routing through
    # ours. Both produce the same text; the difference is which stream it lands
    # on, and a caller that captures its own output should keep capturing it.
    $global:ChaosStudyRendererIsFallback = $true

    function global:Write-Card {
        <#
        .SYNOPSIS
            Plain-text stand-in for the host's card renderer.

        .DESCRIPTION
            Accepts the full parameter surface the suite uses, because a
            fallback that rejects a parameter the caller legitimately passes is
            no better than no fallback at all - it turns a cosmetic gap into the
            same CommandNotFoundException by another name.
        #>
        [CmdletBinding()]
        param(
            [Parameter(Mandatory)][string]$Title,
            [AllowEmptyString()][AllowNull()][string]$Body,
            [string]$Status,
            [AllowNull()][object]$Properties,
            [AllowEmptyString()][AllowNull()][string]$JsonPreview
        )
        try {
            $heading = if ([string]::IsNullOrWhiteSpace($Status)) { "## $Title" } else { "## $Title [$Status]" }
            Write-ChaosRenderLine $heading
            if (-not [string]::IsNullOrWhiteSpace($Body)) {
                Write-ChaosRenderLine ''
                foreach ($line in ([string]$Body -split "`r?`n")) { Write-ChaosRenderLine $line }
            }
            if ($null -ne $Properties) {
                Write-ChaosRenderLine ''
                $names = @()
                if ($Properties -is [System.Collections.IDictionary]) {
                    $names = @($Properties.Keys)
                    foreach ($name in $names) {
                        Write-ChaosRenderLine ("  {0}: {1}" -f $name, (ConvertTo-ChaosRenderScalar $Properties[$name]))
                    }
                }
                else {
                    foreach ($property in $Properties.PSObject.Properties) {
                        Write-ChaosRenderLine ("  {0}: {1}" -f $property.Name, (ConvertTo-ChaosRenderScalar $property.Value))
                    }
                }
            }
            if (-not [string]::IsNullOrWhiteSpace($JsonPreview)) {
                Write-ChaosRenderLine ''
                Write-ChaosRenderLine '```json'
                foreach ($line in ([string]$JsonPreview -split "`r?`n")) { Write-ChaosRenderLine $line }
                Write-ChaosRenderLine '```'
            }
            Write-ChaosRenderLine ''
        }
        catch {
            # Presentation must never be the thing that fails a study.
            try { Write-ChaosRenderLine "## $Title" } catch { }
        }
    }
}

if (-not (Get-Command -Name 'Write-Table' -ErrorAction SilentlyContinue)) {
    function global:Write-Table {
        <#
        .SYNOPSIS
            Plain-text stand-in for the host's table renderer.

        .DESCRIPTION
            Columns are taken from the union of the rows' keys rather than from
            the first row alone, so that a row carrying an extra field does not
            quietly lose it.
        #>
        [CmdletBinding()]
        param(
            [string]$Title,
            [AllowNull()][AllowEmptyCollection()][object]$Data
        )
        try {
            if (-not [string]::IsNullOrWhiteSpace($Title)) { Write-ChaosRenderLine "### $Title" }
            $rows = @()
            if ($null -ne $Data) { foreach ($item in @($Data)) { if ($null -ne $item) { $rows += $item } } }
            if ($rows.Count -eq 0) {
                Write-ChaosRenderLine '(none)'
                Write-ChaosRenderLine ''
                return
            }

            $columns = @()
            foreach ($row in $rows) {
                $names = if ($row -is [System.Collections.IDictionary]) { @($row.Keys) } else { @($row.PSObject.Properties.Name) }
                foreach ($name in $names) { if ($columns -notcontains $name) { $columns += $name } }
            }
            if ($columns.Count -eq 0) {
                foreach ($row in $rows) { Write-ChaosRenderLine (ConvertTo-ChaosRenderScalar $row) }
                Write-ChaosRenderLine ''
                return
            }

            Write-ChaosRenderLine ('| ' + ($columns -join ' | ') + ' |')
            Write-ChaosRenderLine ('| ' + (($columns | ForEach-Object { '---' }) -join ' | ') + ' |')
            foreach ($row in $rows) {
                $cells = @()
                foreach ($column in $columns) {
                    $value = $null
                    if ($row -is [System.Collections.IDictionary]) {
                        if ($row.Contains($column)) { $value = $row[$column] }
                    }
                    elseif ($row.PSObject.Properties.Name -contains $column) {
                        $value = $row.$column
                    }
                    $cells += ((ConvertTo-ChaosRenderScalar $value) -replace '\|', '\|')
                }
                Write-ChaosRenderLine ('| ' + ($cells -join ' | ') + ' |')
            }
            Write-ChaosRenderLine ''
        }
        catch {
            try { if (-not [string]::IsNullOrWhiteSpace($Title)) { Write-ChaosRenderLine "### $Title" } } catch { }
        }
    }
}

if (-not (Get-Command -Name 'Write-Error-Card' -ErrorAction SilentlyContinue)) {
    function global:Write-Error-Card {
        <#
        .SYNOPSIS
            Plain-text stand-in for the host's error card.

        .DESCRIPTION
            Returns its lines rather than printing them, because the suite's own
            Write-ChaosStudyFailure collects the result and writes it - matching
            the host renderer's contract at that call site.
        #>
        [CmdletBinding()]
        param(
            [Parameter(Mandatory)][string]$Title,
            [AllowEmptyString()][AllowNull()][string]$ErrorMessage,
            [AllowEmptyString()][AllowNull()][string]$RemediationCommand
        )
        $lines = @("## ERROR: $Title", '')
        if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $lines += $ErrorMessage }
        if (-not [string]::IsNullOrWhiteSpace($RemediationCommand)) {
            $lines += ''
            $lines += "Remediation: $RemediationCommand"
        }
        return $lines
    }
}

# -- Suite-facing wrappers ---------------------------------------------------
# The skills call these rather than Write-Card/Write-Table directly. Two
# reasons, both learned from the renderers actually in the field:
#
#   * The plugin's Write-Table declares -Data as a MANDATORY [array], so an
#     empty result set - no findings, no prior studies, nothing persisted - is
#     rejected at parameter binding and takes down the phase that was merely
#     trying to say "none".
#   * It reads each column with $item.$column, which throws under StrictMode
#     when one row happens to lack a field another row has.
#
# Neither is ours to fix: copilot-cli-plugin/scripts/Render.ps1 is shipped code
# outside this suite. So the suite normalises before it hands anything over,
# and treats presentation as something that must never fail a study.

function Write-ChaosStudyTable {
    <#
    .SYNOPSIS
        Render a table safely against whichever renderer is present.

    .DESCRIPTION
        Rows are projected onto the union of their columns, with missing values
        rendered as blank rather than omitted, so every row is shape-identical
        by the time any renderer sees it. An empty set prints a plain "(none)"
        instead of being passed to a renderer that would reject it.
    #>
    param(
        [string]$Title,
        [AllowNull()][AllowEmptyCollection()][object]$Data,
        [string]$EmptyText = '(none)'
    )
    try {
        $rows = @()
        if ($null -ne $Data) { foreach ($item in @($Data)) { if ($null -ne $item) { $rows += $item } } }

        if ($rows.Count -eq 0) {
            if (-not [string]::IsNullOrWhiteSpace($Title)) { Write-ChaosRenderLine "### $Title" }
            Write-ChaosRenderLine $EmptyText
            Write-ChaosRenderLine ''
            return
        }

        $columns = @()
        foreach ($row in $rows) {
            $names = if ($row -is [System.Collections.IDictionary]) { @($row.Keys) } else { @($row.PSObject.Properties.Name) }
            foreach ($name in $names) { if ($columns -notcontains $name) { $columns += $name } }
        }

        $normalised = @()
        foreach ($row in $rows) {
            $projected = [ordered]@{}
            foreach ($column in $columns) {
                $value = $null
                if ($row -is [System.Collections.IDictionary]) {
                    if ($row.Contains($column)) { $value = $row[$column] }
                }
                elseif ($row.PSObject.Properties.Name -contains $column) {
                    $value = $row.$column
                }
                $projected[$column] = ConvertTo-ChaosRenderScalar $value
            }
            $normalised += [pscustomobject]$projected
        }

        if ([string]::IsNullOrWhiteSpace($Title)) {
            Write-Table -Data $normalised
        } else {
            Write-Table -Title $Title -Data $normalised
        }
    }
    catch {
        # Fall back to text rather than lose the content or the phase.
        try {
            if (-not [string]::IsNullOrWhiteSpace($Title)) { Write-ChaosRenderLine "### $Title" }
            foreach ($row in @($Data)) { Write-ChaosRenderLine (ConvertTo-ChaosRenderScalar $row) }
            Write-ChaosRenderLine ''
        } catch { }
    }
}

function Write-ChaosStudyPanel {
    <#
    .SYNOPSIS
        Render a card safely against whichever renderer is present.

    .DESCRIPTION
        Only the parameters the caller actually supplied are forwarded, so a
        renderer that does not accept one of the optional ones is never handed
        it. A rendering failure degrades to plain text: the study has already
        done its work by the time it reports, and losing the description of it
        must not also lose the exit code.
    #>
    param(
        [Parameter(Mandatory)][string]$Title,
        [AllowEmptyString()][AllowNull()][string]$Body,
        [string]$Status,
        [AllowNull()][object]$Properties,
        [AllowEmptyString()][AllowNull()][string]$JsonPreview
    )
    try {
        $arguments = @{ Title = $Title }
        if ($null -ne $Body) { $arguments['Body'] = [string]$Body }
        if (-not [string]::IsNullOrWhiteSpace($Status)) { $arguments['Status'] = $Status }
        if ($null -ne $Properties) {
            # The plugin renderer types -Properties as [hashtable]; an ordered
            # dictionary is not one, and binding would fail.
            if ($Properties -is [hashtable]) {
                $arguments['Properties'] = $Properties
            }
            elseif ($Properties -is [System.Collections.IDictionary]) {
                $flat = @{}
                foreach ($key in $Properties.Keys) { $flat[[string]$key] = ConvertTo-ChaosRenderScalar $Properties[$key] }
                $arguments['Properties'] = $flat
            }
            else {
                $flat = @{}
                foreach ($property in $Properties.PSObject.Properties) { $flat[$property.Name] = ConvertTo-ChaosRenderScalar $property.Value }
                $arguments['Properties'] = $flat
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($JsonPreview)) { $arguments['JsonPreview'] = $JsonPreview }
        Write-Card @arguments
    }
    catch {
        try {
            Write-ChaosRenderLine "## $Title"
            if (-not [string]::IsNullOrWhiteSpace($Body)) {
                Write-ChaosRenderLine ''
                foreach ($line in ([string]$Body -split "`r?`n")) { Write-ChaosRenderLine $line }
            }
            Write-ChaosRenderLine ''
        } catch { }
    }
}