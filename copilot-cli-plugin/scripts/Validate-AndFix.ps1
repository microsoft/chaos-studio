<#
.SYNOPSIS
    Shared helper: validate a ScenarioConfiguration and auto-fix resource permissions.
.DESCRIPTION
    Drives the validate -> fixResourcePermissions -> re-validate loop against a
    Microsoft.Chaos ScenarioConfiguration. Used by both the setup-scenario skill
    (creation-time validation) and run-scenario skill (pre-execute gate).

    Behavior (always-on validation + always-on remediation when applicable):
      1. POST {configUri}/validate and poll Location LRO.
      2. GET {configUri}/validations/latest -> $valStatus.
      3. If $valStatus is NOT 'Succeeded' (i.e. Failed/RequiresAttention/etc.) OR
         validationErrors are present, POST {configUri}/fixResourcePermissions
         with whatIf=false, poll fixResourcePermissions/latest until terminal,
         then re-POST /validate and re-GET /validations/latest.
      4. Returns the final validation status string.

    State persistence:
      - Always writes the final validation status to
        "$StateBasePath.validation.lastResult".
      - When fix runs, also writes:
          $StateBasePath.validation.permissionFix.state
          $StateBasePath.validation.permissionFix.summary
          $StateBasePath.validation.permissionFix.whatIfMode

    Required dot-sourced dependencies (caller must load before invoking):
      State.ps1, Render.ps1, Invoke-AzRest.ps1, Wait-AzureLro.ps1

.PARAMETER ConfigUri
    Full ARM path to the ScenarioConfiguration
    (e.g. /subscriptions/.../configurations/{name}).
.PARAMETER StateBasePath
    Dotted state path under which to persist validation/permissionFix results
    (e.g. 'setup.configuration' or 'run.preValidation').
.PARAMETER ApiVersion
    Data-plane API version. Defaults to 2026-05-01-preview.

.OUTPUTS
    None. Callers should read the final status from state at
    "$StateBasePath.validation.lastResult" after this function returns.
#>
function Invoke-ValidateAndFix {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ConfigUri,
        [Parameter(Mandatory)][string]$StateBasePath,
        [Parameter()][string]$ApiVersion = '2026-05-01-preview'
    )

    $validateUri   = "$ConfigUri/validate"
    $validationUri = "$ConfigUri/validations/latest"
    $fixUri        = "$ConfigUri/fixResourcePermissions"

    # ── Step 1: Initial validate ────────────────────────────
    Write-Card -Title 'Validating Configuration' -Status '🔄' `
        -Body 'Verifying that the workspace identity has sufficient permissions on all target resources...'

    $validateResp = Invoke-AzRest -Method POST -Uri $validateUri -ApiVersion $ApiVersion
    if ($validateResp.headers -and $validateResp.headers['Location']) {
        Wait-AzureLro -PollUrl $validateResp.headers['Location'] -Style 'location' | Out-Null
    }

    $valResult = Invoke-AzRest -Method GET -Uri $validationUri -ApiVersion $ApiVersion
    $valStatus = $valResult.body.properties.status
    Set-StateProperty -PropertyPath "$StateBasePath.validation.lastResult" -Value $valStatus

    # ── Step 2: Decide whether a fix is needed ──────────────
    # ALWAYS attempt a fix when validation did not return Succeeded, OR when
    # the service reported any validationErrors. The previous logic only fired
    # when validationErrors.permission was populated, which silently allowed
    # 'RequiresAttention' to pass through to execution.
    $hasErrors  = [bool]$valResult.body.properties.validationErrors
    $needsFix   = ($valStatus -ne 'Succeeded') -or $hasErrors

    if (-not $needsFix) {
        Write-Card -Title 'Validation Complete' -Status "✅ $valStatus"
        return
    }

    # ── Step 3: Attempt fixResourcePermissions ──────────────
    Write-Card -Title 'Validation Needs Attention — Auto-Fixing Permissions' -Status '⚠️' `
        -Body "Validation status: ``$valStatus``. Attempting ``fixResourcePermissions`` (whatIf=false)..."

    $fixBody = @{ whatIf = $false }
    try {
        $fixResp = Invoke-AzRest -Method POST -Uri $fixUri -ApiVersion $ApiVersion -Body $fixBody
    } catch {
        $fixErr = $_.Exception.Message
        if ($fixErr -match '(?i)(403|Forbidden|AuthorizationFailed|Authorization_RequestDenied)') {
            Write-Error-Card -Title 'Permission Fix Failed — 403 Forbidden' `
                -ErrorMessage @"
The workspace identity does not have permission to create role assignments on the target scope.
The ``fixResourcePermissions`` API needs ``Microsoft.Authorization/roleAssignments/write`` on the workspace scope.

To resolve this, contact your security administrator and ask them to either:
  1. Grant you (or the workspace identity) the **User Access Administrator** or **Owner** role on the scope so that ``fixResourcePermissions`` can auto-assign the required roles.
  2. Run the ``fixResourcePermissions`` command themselves with elevated privileges:
     az rest --method POST --uri "$fixUri`?api-version=$ApiVersion" --body '{"whatIf":false}' --resource "https://management.azure.com/"

Original error: $fixErr
"@
            throw "fixResourcePermissions 403: $fixErr"
        }
        throw
    }

    if ($fixResp.headers -and $fixResp.headers['Location']) {
        $fixLro = Wait-AzureLro -PollUrl $fixResp.headers['Location'] -Style 'location'
    }

    # Try GET /fixResourcePermissions/latest. Some service versions don't
    # populate this endpoint, in which case we fall back to the LRO body
    # (which Wait-AzureLro already retrieved as the terminal response).
    $fixResultUri = "$ConfigUri/fixResourcePermissions/latest"
    $fixResult    = $null
    $fixState     = $null
    for ($i = 0; $i -lt 6; $i++) {
        try {
            $fixResult = Invoke-AzRest -Method GET -Uri $fixResultUri -ApiVersion $ApiVersion
            $fixState  = $fixResult.body.properties.state
            if ($fixState -and $fixState -notin @('Running','Pending','Accepted','InProgress','Creating')) {
                break
            }
        } catch {
            $em = $_.Exception.Message
            if ($em -notmatch '(?i)(404|Not Found|NotFound)') { throw }
            # 404 — endpoint not yet populated; brief retry then fall back.
        }
        Start-Sleep -Seconds 3
    }

    if (-not $fixResult -or -not $fixState) {
        if ($fixLro -and $fixLro.body) {
            Write-Card -Title 'Note' -Status 'ℹ️' `
                -Body '``fixResourcePermissions/latest`` not available; using LRO terminal response as the fix result.'
            $fixResult = $fixLro
            $fixState  = if ($fixLro.body.properties.state) { $fixLro.body.properties.state } else { $fixLro.status }
        } else {
            # No /latest record AND no LRO body — proceed but warn; re-validation below is the real gate.
            Write-Card -Title 'Note' -Status 'ℹ️' `
                -Body '``fixResourcePermissions`` completed but neither ``/latest`` nor the LRO returned a result body. Relying on re-validation to confirm the outcome.'
            $fixResult = [PSCustomObject]@{ body = [PSCustomObject]@{ properties = [PSCustomObject]@{ state = 'Unknown'; summary = [PSCustomObject]@{ totalRequired = 0; succeeded = 0; failed = 0; skipped = 0 }; whatIfMode = $false } } }
            $fixState  = 'Unknown'
        }
    }

    $fixSummary    = $fixResult.body.properties.summary
    $fixWhatIfMode = $fixResult.body.properties.whatIfMode

    Set-StateProperty -PropertyPath "$StateBasePath.validation.permissionFix.state"      -Value $fixState
    Set-StateProperty -PropertyPath "$StateBasePath.validation.permissionFix.summary"    -Value $fixSummary
    Set-StateProperty -PropertyPath "$StateBasePath.validation.permissionFix.whatIfMode" -Value $fixWhatIfMode

    if ($fixWhatIfMode -eq $true) {
        Write-Card -Title 'WARNING — fixResourcePermissions ran in WHAT-IF mode' -Status '⚠️' -Body @"
The service returned ``whatIfMode: true``, meaning **no role assignments were actually created**.
This is unexpected because the request body explicitly sent ``whatIf: false``.
Subsequent execution will likely fail with RBAC errors.
"@
    }

    if ($fixSummary.failed -gt 0) {
        Write-Error-Card -Title 'Some Permission Fixes Failed' `
            -ErrorMessage @"
$($fixSummary.failed) of $($fixSummary.totalRequired) required role assignments could not be created.
This typically means the workspace identity lacks ``Microsoft.Authorization/roleAssignments/write`` on one or more target resources.

To resolve this, contact your security administrator and ask them to either:
  1. Grant the workspace identity the required roles manually.
  2. Run the ``fixResourcePermissions`` command with elevated privileges:
     az rest --method POST --uri "$fixUri`?api-version=$ApiVersion" --body '{"whatIf":false}' --resource "https://management.azure.com/"
"@
    }

    Write-Card -Title 'Permission Fix Result' -Status $fixState -Properties ([ordered]@{
        'Total Required' = $fixSummary.totalRequired
        'Succeeded'      = $fixSummary.succeeded
        'Failed'         = $fixSummary.failed
        'Skipped'        = $fixSummary.skipped
    })

    # ── Step 4: Re-validate after fix ───────────────────────
    Write-Card -Title 'Re-validating Configuration' -Status '🔄'

    $reValidateResp = Invoke-AzRest -Method POST -Uri $validateUri -ApiVersion $ApiVersion
    if ($reValidateResp.headers -and $reValidateResp.headers['Location']) {
        Wait-AzureLro -PollUrl $reValidateResp.headers['Location'] -Style 'location' | Out-Null
    }
    $reValResult = Invoke-AzRest -Method GET -Uri $validationUri -ApiVersion $ApiVersion
    $valStatus = $reValResult.body.properties.status
    Set-StateProperty -PropertyPath "$StateBasePath.validation.lastResult" -Value $valStatus

    # ── Step 5: Wait for RBAC propagation ───────────────────
    # New role assignments take 30s-5min to propagate in ARM. If validation is
    # still not 'Succeeded' immediately after the fix, retry on an interval —
    # but ONLY when the failure looks like it could be a transient permission
    # propagation issue (i.e. the validation reports validationErrors, not a
    # service InternalError or other non-RBAC condition). For non-permission
    # failures, retrying wastes time, so we fall through to the strict gate.
    if ($valStatus -ne 'Succeeded') {
        $isPermissionRelated = $true
        $reValErrors = $reValResult.body.properties.errors
        if ($reValErrors -and $reValErrors.Count -gt 0) {
            # If every error code looks non-permission-related, bail out of the wait loop.
            $nonPermCodes = @($reValErrors | Where-Object { $_.errorCode -notmatch '(?i)(Permission|Authoriz|Forbidden|RBAC|RoleAssignment)' })
            if ($nonPermCodes.Count -eq $reValErrors.Count) {
                $isPermissionRelated = $false
            }
        }

        if (-not $isPermissionRelated) {
            Write-Card -Title 'Skipping Propagation Wait' -Status 'ℹ️' -Body @"
Validation status is ``$valStatus`` but the errors do not look RBAC-related:
$(($reValErrors | ForEach-Object { "- **$($_.errorCode)**: $($_.errorMessage)" }) -join "`n")

Retrying validation will not help. The strict pre-execute gate will block execution below.
"@
        } else {
            $maxWaitSeconds      = 300   # 5 minutes total — typical RBAC propagation
            $intervalSeconds     = 20
            $maxAttempts         = [Math]::Ceiling($maxWaitSeconds / $intervalSeconds)
            $deadline            = (Get-Date).AddSeconds($maxWaitSeconds)

            Write-Card -Title 'Waiting for RBAC Propagation' -Status '⏳' -Body @"
Validation is still ``$valStatus`` immediately after the permission fix.
Azure role assignments can take up to **5 minutes** to propagate.
Re-validating every $intervalSeconds seconds (up to $maxAttempts attempts) until ``Succeeded`` or timeout...
"@

            $attempt = 0
            while ((Get-Date) -lt $deadline -and $valStatus -ne 'Succeeded') {
                $attempt++
                Start-Sleep -Seconds $intervalSeconds

                try {
                    $polResp = Invoke-AzRest -Method POST -Uri $validateUri -ApiVersion $ApiVersion
                    if ($polResp.headers -and $polResp.headers['Location']) {
                        Wait-AzureLro -PollUrl $polResp.headers['Location'] -Style 'location' | Out-Null
                    }
                    $polResult = Invoke-AzRest -Method GET -Uri $validationUri -ApiVersion $ApiVersion
                    $valStatus = $polResult.body.properties.status
                    Set-StateProperty -PropertyPath "$StateBasePath.validation.lastResult" -Value $valStatus

                    $elapsedSec = [int]((Get-Date) - $deadline.AddSeconds(-$maxWaitSeconds)).TotalSeconds
                    Write-Card -Title "Propagation Check $attempt/$maxAttempts" -Status "$(if ($valStatus -eq 'Succeeded') {'✅'} else {'⏳'}) $valStatus" `
                        -Body "Elapsed: ${elapsedSec}s of ${maxWaitSeconds}s budget."

                    if ($valStatus -eq 'Succeeded') { break }
                } catch {
                    # Transient errors during propagation are expected; keep polling.
                    Write-Card -Title "Propagation Check $attempt/$maxAttempts" -Status '⚠️ transient' `
                        -Body "Validation call failed: $($_.Exception.Message). Will retry."
                }
            }
        }
    }

    Write-Card -Title 'Validation Complete (post-fix)' -Status "$(if ($valStatus -eq 'Succeeded') {'✅'} else {'⚠️'}) $valStatus"
}
