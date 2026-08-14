Describe "Chaos Loop deterministic policy" {
    BeforeAll {
        $script:pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." ".." "..")).Path
        $script:stateTool = Join-Path $script:pluginRoot "scripts" "chaos_loop_state.py"

        function Invoke-PolicyFunction {
            param(
                [Parameter(Mandatory)]
                [string]$Code,
                [Parameter(Mandatory)]
                $InputValue
            )
            $inputPath = Join-Path $TestDrive ("policy-" + [guid]::NewGuid() + ".json")
            [System.IO.File]::WriteAllText(
                $inputPath,
                ($InputValue | ConvertTo-Json -Depth 100)
            )
            $output = @(& python -c $Code $script:stateTool $inputPath 2>&1)
            $LASTEXITCODE | Should -Be 0 -Because ($output -join "`n")
            return (($output -join "`n") | ConvertFrom-Json -AsHashtable)
        }

        function New-PolicyHypothesis {
            param(
                [string]$Id,
                [int]$Likelihood
            )
            $target = "/subscriptions/000/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1"
            return @{
                hypothesisId = $Id
                rank = 99
                statement = "CPU pressure exposes unbounded work."
                codeOrIaCEvidence = @(@{ location = "src/Worker.cs"; evidence = "unbounded" })
                scenarioEligibility = @{
                    discovered = $true
                    configurationValidated = $true
                    safetyEligible = $true
                }
                rankingInputs = @{
                    likelihood = $Likelihood
                    blastRadius = 3
                    falsifiability = 4
                }
                matchingFault = @{
                    scenarioName = "CPU-Pressure-1.0"
                    configurationName = "cpu-test"
                    faultType = "cpuPressure"
                    parameters = @{ pressure = 80 }
                    targetResources = @($target)
                    blastRadius = @{ scope = "one VM"; targets = @($target) }
                    duration = "PT5M"
                }
                steadyStatePredicates = @(@{ predicate = "ready"; queryOrSource = "/health" })
                workExpected = @{ predicate = "jobs exist"; query = "jobs | count" }
                provingFault = @{
                    predicate = "CPU action active"
                    requiredEvidence = @("action")
                    queryOrSource = "run summary"
                }
                confirmPredicate = @{
                    predicate = "failures exceed threshold"
                    telemetryQuery = "jobs | where failed | count"
                    metric = "failures"
                    operator = ">"
                    threshold = 5
                    unit = "count"
                    window = "fault"
                }
                executedCodePathPredicate = @{
                    predicate = "worker span exists"
                    queryOrTrace = "traces"
                }
            }
        }
    }

    It "filters unsupported scenarios and stably selects by score then ID" {
        $highB = New-PolicyHypothesis -Id "H-B" -Likelihood 5
        $highA = New-PolicyHypothesis -Id "H-A" -Likelihood 5
        $low = New-PolicyHypothesis -Id "H-C" -Likelihood 2
        $invalid = New-PolicyHypothesis -Id "H-X" -Likelihood 5
        $invalid.matchingFault.scenarioName = "Invented-Fault-1.0"
        $code = @'
import importlib.util,json,sys
s=importlib.util.spec_from_file_location("cl",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
items=json.load(open(sys.argv[2],encoding="utf-8")); ranked,rejected=m.filter_and_rank_hypotheses(items)
print(json.dumps({"ids":[x["hypothesisId"] for x in ranked],"ranks":[x["rank"] for x in ranked],"rejected":rejected}))
'@
        $result = Invoke-PolicyFunction -Code $code -InputValue @($low, $highB, $invalid, $highA)

        $result.ids | Should -Be @("H-A", "H-B", "H-C")
        $result.ranks | Should -Be @(1, 2, 3)
        $result.rejected[0].hypothesisId | Should -Be "H-X"
    }

    It "computes the verdict matrix from explicit exercise booleans" {
        $matrix = @(
            @{
                mode = "initial"
                value = @{
                    provingFault = @{ satisfied = $true }
                    eligibleWorkObserved = $true
                    executedCodePathEvidence = @("span")
                    telemetryAvailable = $true
                    confirmPredicate = @{ evaluatedTrue = $true }
                }
            },
            @{
                mode = "initial"
                value = @{
                    provingFault = @{ satisfied = $true }
                    eligibleWorkObserved = $true
                    executedCodePathEvidence = @("span")
                    telemetryAvailable = $true
                    confirmPredicate = @{ evaluatedTrue = $false }
                }
            },
            @{
                mode = "verify"
                value = @{
                    provingFault = @{ satisfied = $true }
                    eligibleWorkObserved = $true
                    executedCodePathEvidence = @("span")
                    changedCodePathObserved = $false
                    telemetryAvailable = $true
                    confirmPredicate = @{ evaluatedTrue = $false }
                }
            }
        )
        $code = @'
import importlib.util,json,sys
s=importlib.util.spec_from_file_location("cl",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
items=json.load(open(sys.argv[2],encoding="utf-8"));print(json.dumps([m.deterministic_verdict(x["value"],x["mode"]) for x in items]))
'@
        $result = Invoke-PolicyFunction -Code $code -InputValue $matrix

        $result | Should -Be @("CONFIRMED", "REFUTED", "NOT EXERCISED")
    }

    It "calculates SLI and DLQ deltas without converting unavailable data to zero" {
        $evidence = @{
            observedSLIs = @(
                @{ value = 95.0; baselineValue = 99.0; query = "availability" },
                @{ value = $null; baselineValue = 99.0; query = "availability"; caveat = "missing" }
            )
            dlqState = @(
                @{ entity = "orders"; baselineCount = 2; currentCount = 7; query = "dlq" }
            )
        }
        $code = @'
import importlib.util,json,sys
s=importlib.util.spec_from_file_location("cl",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.load(open(sys.argv[2],encoding="utf-8"));m.calculate_numeric_evidence(v);print(json.dumps(v))
'@
        $result = Invoke-PolicyFunction -Code $code -InputValue $evidence

        $result.observedSLIs[0].absoluteDelta | Should -Be -4
        $result.observedSLIs[1].absoluteDelta | Should -BeNullOrEmpty
        $result.dlqState[0].delta | Should -Be 5
    }

    It "computes advisory ledger categories and stable set identity" {
        $prior = @(
            @{ advisoryId = "A1"; title = "same" },
            @{ advisoryId = "A2"; title = "old" },
            @{ advisoryId = "A4"; title = "removed" }
        )
        $current = @(
            @{ advisoryId = "A1"; title = "same" },
            @{ advisoryId = "A2"; title = "changed" },
            @{ advisoryId = "A3"; title = "new" }
        )
        $code = @'
import importlib.util,json,sys
s=importlib.util.spec_from_file_location("cl",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.load(open(sys.argv[2],encoding="utf-8"));print(json.dumps(m.advisory_ledger(v["prior"],v["current"])))
'@
        $result = Invoke-PolicyFunction -Code $code -InputValue @{ prior = $prior; current = $current }

        $result.added[0].advisoryId | Should -Be "A3"
        $result.changed[0].advisoryId | Should -Be "A2"
        $result.unchanged[0].advisoryId | Should -Be "A1"
        $result.removed[0].advisoryId | Should -Be "A4"
        $result.currentSetId | Should -Match "^advisory-set-"
    }

    It "parses nested SQL ARM resource types" {
        $inputValue = @{
            resourceId = "/subscriptions/000/resourceGroups/rg/providers/Microsoft.Sql/servers/sql1/databases/orders"
        }
        $code = @'
import importlib.util,json,sys
s=importlib.util.spec_from_file_location("cl",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.load(open(sys.argv[2],encoding="utf-8"));print(json.dumps({"type":m.arm_resource_type(v["resourceId"])}))
'@
        $result = Invoke-PolicyFunction -Code $code -InputValue $inputValue

        $result.type | Should -Be "Microsoft.Sql/servers/databases"
    }

    It "selects the specific database catalog rule before generic Compute Zone Down" {
        $inputValue = @{ scenario = "Compute-Zone-Down-PostgreSQL-Failover-1.0" }
        $code = @'
import importlib.util,json,sys
s=importlib.util.spec_from_file_location("cl",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.load(open(sys.argv[2],encoding="utf-8"));print(json.dumps(m.scenario_catalog_entry(v["scenario"])))
'@
        $result = Invoke-PolicyFunction -Code $code -InputValue $inputValue

        $result.family | Should -Be "Database Resilience"
    }

    It "escalates verify REFUTED when the SLO still fails and no backlog remains" {
        $inputValue = @{
            verdict = "REFUTED"
            mode = "verify"
            backlog = $false
            sloHolds = $false
            iteration = 1
            maxIterations = 3
            fixable = $false
        }
        $code = @'
import importlib.util,json,sys
s=importlib.util.spec_from_file_location("cl",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v=json.load(open(sys.argv[2],encoding="utf-8"));print(json.dumps(m.deterministic_diagnostic_route(v["verdict"],v["mode"],v["backlog"],v["sloHolds"],v["iteration"],v["maxIterations"],v["fixable"])))
'@
        $result = Invoke-PolicyFunction -Code $code -InputValue $inputValue

        $result | Should -Be @("escalated", "terminated", "terminated")
    }

}
