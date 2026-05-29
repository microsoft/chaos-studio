<#
.SYNOPSIS
    Pester wrapper around Run-Hermetic.ps1 so the offline E2E participates
    in the same `Invoke-Pester ./tests` invocation the CI uses for the
    unit tests.

.DESCRIPTION
    The actual E2E logic lives in `Run-Hermetic.ps1` (the file the plan
    specifies). This wrapper invokes it as a child process and asserts
    PASS / wall-clock budget. Keeping the driver as a standalone script
    means it can also be invoked directly by developers and the parent
    CI workflow without booting Pester.
#>

BeforeAll {
    $script:E2EDir   = $PSScriptRoot
    $script:RunnerPs = Join-Path $script:E2EDir 'Run-Hermetic.ps1'
}

Describe 'Hermetic E2E driver' {
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
