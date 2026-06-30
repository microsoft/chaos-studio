<#
.SYNOPSIS
    Pester wrapper around Run-OfflineReplay.ps1 so the offline-replay E2E
    participates in the same `Invoke-Pester ./tests` invocation the CI uses
    for the unit tests.

.DESCRIPTION
    The actual E2E logic lives in `Run-OfflineReplay.ps1`. This wrapper
    invokes it as a child process and asserts PASS / wall-clock budget.
    Keeping the driver as a standalone script means it can also be invoked
    directly by developers and the parent CI workflow without booting Pester.

    NOTE on naming: this suite is "hermetic" only in the strict sense
    (sealed, deterministic, no network — fixtures are replayed from
    recorded JSON). It does NOT validate the live ARM/Monitor contract,
    and the Log Analytics path is intentionally skipped here. See
    docs/impact-synthesis-skill.plan.md and the follow-up issue for
    contract drift + true live E2E.
#>

BeforeAll {
    $script:E2EDir   = $PSScriptRoot
    $script:RunnerPs = Join-Path $script:E2EDir 'Run-OfflineReplay.ps1'
}

Describe 'Offline-replay E2E driver' {
    It 'exists and is executable' {
        Test-Path $script:RunnerPs | Should -BeTrue
    }

    It 'passes within the 30s offline budget' {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $proc = Start-Process -FilePath 'pwsh' `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $script:RunnerPs) `
            -NoNewWindow -Wait -PassThru
        $sw.Stop()
        $proc.ExitCode      | Should -Be 0
        $sw.Elapsed.TotalSeconds | Should -BeLessThan 30
    }
}
