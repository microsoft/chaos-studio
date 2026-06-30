<#
.SYNOPSIS
    Markdown rendering helpers for the startchaos plugin.

.DESCRIPTION
    All user-facing output uses fixed Markdown card templates.
    No ANSI colours — output is designed for Copilot CLI rendering.

    Functions:
      Write-Card          — general-purpose info/status card
      Write-Table         — renders a table from objects or arrays
      Write-Error-Card    — error card with optional remediation command

.NOTES
    Design principle D4: Output is Markdown with fixed card templates.
#>

function Write-Card {
    <#
    .SYNOPSIS
        Renders a Markdown card with a title, optional status badge, body text,
        and optional JSON preview.
    .PARAMETER Title
        Card heading (rendered as ## heading).
    .PARAMETER Status
        Optional status string shown as a badge after the title (e.g. "✅ Done").
    .PARAMETER Body
        Main body text — Markdown-formatted.
    .PARAMETER JsonPreview
        Optional object to render as a fenced JSON code block.
    .PARAMETER Properties
        Optional ordered hashtable rendered as a key-value list.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Title,

        [Parameter()]
        [string]$Status,

        [Parameter()]
        [string]$Body,

        [Parameter()]
        [object]$JsonPreview,

        [Parameter()]
        [hashtable]$Properties
    )

    $lines = @()

    # Title with optional status
    if ($Status) {
        $lines += "## $Title — $Status"
    } else {
        $lines += "## $Title"
    }
    $lines += ''

    # Properties as key-value list
    if ($Properties -and $Properties.Count -gt 0) {
        foreach ($key in $Properties.Keys) {
            $lines += "- **${key}:** $($Properties[$key])"
        }
        $lines += ''
    }

    # Body text
    if ($Body) {
        $lines += $Body
        $lines += ''
    }

    # JSON preview in fenced block
    if ($null -ne $JsonPreview) {
        $json = if ($JsonPreview -is [string]) {
            $JsonPreview
        } else {
            $JsonPreview | ConvertTo-Json -Depth 16
        }
        $lines += '```json'
        $lines += $json
        $lines += '```'
        $lines += ''
    }

    $output = $lines -join "`n"
    Write-Output $output
}

function Write-Table {
    <#
    .SYNOPSIS
        Renders a Markdown table from an array of objects or hashtables.
    .PARAMETER Data
        Array of objects (or hashtables) to render as rows.
    .PARAMETER Columns
        Optional array of column names. If omitted, uses the keys from the
        first item.
    .PARAMETER Title
        Optional heading above the table.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [array]$Data,

        [Parameter()]
        [string[]]$Columns,

        [Parameter()]
        [string]$Title
    )

    if ($Data.Count -eq 0) {
        Write-Output '*(empty)*'
        return
    }

    # Resolve columns
    if (-not $Columns) {
        $first = $Data[0]
        if ($first -is [System.Collections.IDictionary]) {
            $Columns = @($first.Keys)
        } elseif ($first -is [hashtable]) {
            $Columns = @($first.Keys)
        } else {
            $Columns = @($first.PSObject.Properties.Name)
        }
    }

    $lines = @()

    if ($Title) {
        $lines += "### $Title"
        $lines += ''
    }

    # Header row
    $lines += '| ' + ($Columns -join ' | ') + ' |'
    $lines += '| ' + (($Columns | ForEach-Object { '---' }) -join ' | ') + ' |'

    # Data rows
    foreach ($item in $Data) {
        $cells = foreach ($col in $Columns) {
            $val = if ($item -is [System.Collections.IDictionary]) { $item[$col] } elseif ($item -is [hashtable]) { $item[$col] } else { $item.$col }
            if ($null -eq $val) { '' } else { "$val" }
        }
        $lines += '| ' + ($cells -join ' | ') + ' |'
    }

    $lines += ''
    $output = $lines -join "`n"
    Write-Output $output
}

function Write-Error-Card {
    <#
    .SYNOPSIS
        Renders a Markdown error card with a title, error message, and optional
        remediation command.
    .PARAMETER Title
        Error card heading.
    .PARAMETER ErrorMessage
        The error description.
    .PARAMETER RemediationCommand
        Optional shell command the user can run to fix the problem.
    .PARAMETER Details
        Optional additional context or stack trace.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Title,

        [Parameter(Mandatory)]
        [string]$ErrorMessage,

        [Parameter()]
        [string]$RemediationCommand,

        [Parameter()]
        [string]$Details
    )

    $lines = @()

    $lines += "## ❌ $Title"
    $lines += ''
    $lines += "**Error:** $ErrorMessage"
    $lines += ''

    if ($Details) {
        $lines += $Details
        $lines += ''
    }

    if ($RemediationCommand) {
        $lines += '**Remediation:**'
        $lines += ''
        $lines += '```bash'
        $lines += $RemediationCommand
        $lines += '```'
        $lines += ''
    }

    $output = $lines -join "`n"
    Write-Output $output
}

# When imported via Import-Module, all functions are exported by default.
# When dot-sourced, functions are available in the calling scope.
