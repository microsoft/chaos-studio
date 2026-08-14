Describe "Chaos Loop schemas and state controller" {
    BeforeAll {
        $script:pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." ".." "..")).Path
        $script:stateTool = Join-Path $script:pluginRoot "scripts" "chaos_loop_state.py"
        $script:stateSchema = Join-Path $script:pluginRoot "schemas" "chaos-loop" "run-state.v1.schema.json"
        $script:gateSchema = Join-Path $script:pluginRoot "schemas" "chaos-loop" "external-gate.v1.schema.json"
        $script:initialExample = Join-Path $script:pluginRoot "examples" "chaos-loop" "initial-state.json"
        $script:gateExample = Join-Path $script:pluginRoot "examples" "chaos-loop" "external-gate.json"

        function Invoke-StateTool {
            param(
                [Parameter(Mandatory)]
                [string[]]$Arguments
            )

            $lines = @(& python $script:stateTool @Arguments 2>&1)
            $exitCode = $LASTEXITCODE
            $text = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
            $parsed = $null
            if ($text.Trim()) {
                try {
                    $parsed = $text | ConvertFrom-Json -AsHashtable
                } catch {
                    $parsed = $null
                }
            }
            return @{
                ExitCode = $exitCode
                Text = $text
                Json = $parsed
            }
        }

        function Write-Utf8Json {
            param(
                [Parameter(Mandatory)]
                [string]$Path,
                [Parameter(Mandatory)]
                [hashtable]$Value
            )

            $json = $Value | ConvertTo-Json -Depth 100
            [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine)
        }

        function Copy-JsonObject {
            param([Parameter(Mandatory)]$Value)
            return ($Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable)
        }

        function New-EvaluationStamp {
            return @{
                engine = "chaos_loop_state.py"
                policyVersion = "chaos-loop-policy/v2"
            }
        }

        function New-FrozenValidation {
            return [ordered]@{
                scenarioName = "CPU-Pressure-1.0"
                configurationName = "orders-cpu"
                faultType = "urn:csci:microsoft:virtualMachine:cpuPressure/1.0"
                parameters = @{ pressureLevel = 80 }
                targetResources = @("/subscriptions/000/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1")
                blastRadius = @{
                    scope = "one staging VM"
                    targets = @("/subscriptions/000/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1")
                }
                duration = "PT5M"
            }
        }

        function New-Hypothesis {
            param([hashtable]$Frozen)
            return [ordered]@{
                hypothesisId = "H1"
                rank = 1
                statement = "The worker exhausts its request budget under CPU pressure."
                codeOrIaCEvidence = @(
                    @{
                        location = "src/Worker.cs:Process"
                        evidence = "Unbounded concurrency"
                        resilienceMechanism = "bounded concurrency"
                    }
                )
                matchingFault = $Frozen
                scenarioEligibility = @{
                    discovered = $true
                    configurationValidated = $true
                    safetyEligible = $true
                }
                rankingInputs = @{
                    likelihood = 3
                    blastRadius = 3
                    falsifiability = 3
                }
                learningScore = 27
                steadyStatePredicates = @(
                    @{
                        predicate = "health is ready"
                        queryOrSource = "GET /health/ready"
                        threshold = "status == 200"
                    }
                )
                workExpected = @{
                    predicate = "eligible jobs exist"
                    query = "jobs | summarize count()"
                }
                provingFault = @{
                    predicate = "CPU action active on vm1"
                    requiredEvidence = @("action status", "target resource")
                    queryOrSource = "Chaos Scenario run summary"
                }
                confirmPredicate = @{
                    predicate = "failed jobs exceed 5"
                    telemetryQuery = "jobs | where failed | count"
                    metric = "failed jobs"
                    operator = ">"
                    threshold = 5
                    unit = "count"
                    window = "fault window"
                }
                executedCodePathPredicate = @{
                    predicate = "Worker.Process span observed"
                    queryOrTrace = "traces | where name == 'Worker.Process'"
                }
            }
        }

        function Set-ReadyWorkspace {
            param([Parameter(Mandatory)][hashtable]$State)

            $request = $State.workspace.request
            $State.workspace.status = "ready"
            $State.workspace.decision = "reused"
            $State.workspace.selected = @{
                id = "/subscriptions/$($request.subscriptionId)/resourceGroups/$($request.resourceGroup)/providers/Microsoft.Chaos/workspaces/orders-resilience"
                name = "orders-resilience"
                subscriptionId = $request.subscriptionId
                resourceGroup = $request.resourceGroup
                location = $request.location
                identity = @{
                    type = "SystemAssigned"
                    userAssignedIdentityResourceIds = @()
                    principalId = "3d2f8c11-9b74-4a1e-8c55-0a9f7b6e4d21"
                }
                managedScopes = @($request.managedScopes)
                provisioningState = "Succeeded"
            }
            $State.workspace.discoveryEvidence = @{
                source = "chaos_list_workspaces"
                observedAt = "2026-08-13T19:00:05Z"
                candidateCount = 1
                candidateIds = @($State.workspace.selected.id)
            }
            $State.workspace.provisioningEvidence = @{
                source = "chaos_get_workspace"
                decision = "reuse"
                observedAt = "2026-08-13T19:00:06Z"
                workspaceId = $State.workspace.selected.id
                provisioningState = "Succeeded"
                roleAssignments = @()
            }
            $State.workspace.observedAt = "2026-08-13T19:00:06Z"
            $State.workspace.remediationBrief = $null
            return $State
        }

        function New-TestState {
            param(
                [string]$Phase,
                [int]$Revision
            )

            $state = Get-Content $script:initialExample -Raw | ConvertFrom-Json -AsHashtable
            $frozen = New-FrozenValidation
            $hypothesis = New-Hypothesis -Frozen $frozen
            $state.runId = [guid]::NewGuid().ToString()
            $state.faultId = "CPU-Pressure-1.0-20260813T190000Z"
            $state.stateRevision = $Revision
            $state.phase = $Phase
            $state = Set-ReadyWorkspace -State $state
            $state.analysis.mode = "initial"
            $state.analysis.hypotheses = @($hypothesis)
            $state.analysis.selectedHypothesisId = "H1"
            $state.analysis.originalHypothesisId = "H1"
            $state.analysis.routingIntent = "selected"
            $state.frozenValidation = $frozen
            $state.transition = @{
                status = "ready"
                from = "resilience-analysis"
                to = $Phase
                reason = "test fixture"
            }
            return $state
        }
    }

    It "validates the checked-in state example against the versioned schema" {
        $json = Get-Content $script:initialExample -Raw
        $json | Test-Json -SchemaFile $script:stateSchema | Should -BeTrue
    }

    It "validates the checked-in external gate example against the versioned schema" {
        $json = Get-Content $script:gateExample -Raw
        $json | Test-Json -SchemaFile $script:gateSchema | Should -BeTrue
    }

    It "creates one durable state document with revision zero and a pending workspace" {
        $root = Join-Path $TestDrive "runs"
        $subscription = "8f4a2b1c-6d3e-4f57-9a80-1b2c3d4e5f60"
        $result = Invoke-StateTool -Arguments @(
            "start",
            "--repo", "contoso/orders",
            "--commit", "abc123",
            "--target-resources", ("[""/subscriptions/$subscription/resourceGroups/rg-orders/providers/Microsoft.Web/sites/orders""]"),
            "--guardrails", '{"environmentScope":"staging","blastRadiusCap":"one replica","safetyHalts":["availability below 95%"]}',
            "--workspace-request", ("{""subscriptionId"":""$subscription"",""resourceGroup"":""rg-orders"",""location"":""East US"",""managedScopes"":[""/subscriptions/$subscription/resourceGroups/rg-orders""]}"),
            "--state-root", $root
        )

        $result.ExitCode | Should -Be 0 -Because $result.Text
        $statePath = $result.Json.result.statePath
        $statePath | Should -Exist
        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $state.stateRevision | Should -Be 0
        $state.phase | Should -Be "resilience-analysis"
        $state.policyVersion | Should -Be "chaos-loop-policy/v2"
        $state.workspace.status | Should -Be "pending"
        $state.workspace.request.location | Should -Be "eastus"
        $state.workspace.request.identity.type | Should -Be "SystemAssigned"
        $state.workspace.request.identitySpecified | Should -BeFalse
        $state.workspace.selected | Should -BeNullOrEmpty
        $state.events.Count | Should -Be 1
        (Get-ChildItem $root -Recurse -Filter "*.lock").Count | Should -Be 0
    }

    It "refuses to start a run without a workspace request" {
        $root = Join-Path $TestDrive "runs-no-workspace"
        $result = Invoke-StateTool -Arguments @(
            "start",
            "--repo", "contoso/orders",
            "--commit", "abc123",
            "--target-resources", '["/subscriptions/8f4a2b1c-6d3e-4f57-9a80-1b2c3d4e5f60/resourceGroups/rg/providers/Microsoft.Web/sites/orders"]',
            "--guardrails", '{"environmentScope":"staging","blastRadiusCap":"one replica","safetyHalts":["availability below 95%"]}',
            "--state-root", $root
        )

        $result.ExitCode | Should -Not -Be 0
        $result.Text | Should -Match "workspace-request"
        Test-Path $root | Should -BeFalse
    }

    It "migrates legacy policy state once and is idempotent" {
        $state = New-TestState -Phase "advisory" -Revision 4
        $state.Remove("policyVersion")
        $state.Remove("workspace")
        $state.handoff.Remove("analysisDecision")
        $state.handoff.Remove("executionDecision")
        $state.handoff.Remove("diagnosticDecision")
        $state.handoff.advisoryState.Remove("defaultRecommendedAdvisoryIds")
        $state.handoff.codeChanges.Remove("deliveryDecision")
        $state.transition = @{
            status = "blocked"
            from = "advisory"
            to = "advisory"
            reason = "legacy approval"
        }
        $statePath = Join-Path $TestDrive "legacy-state.json"
        Write-Utf8Json -Path $statePath -Value $state

        $first = Invoke-StateTool -Arguments @(
            "migrate",
            "--state", $statePath,
            "--expected-revision", "4"
        )
        $first.ExitCode | Should -Be 0 -Because $first.Text
        $first.Json.result.migrated | Should -BeTrue
        $migrated = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $migrated.phase | Should -Be "advisory-approval"
        $migrated.policyVersion | Should -Be "chaos-loop-policy/v2"
        $migrated.stateRevision | Should -Be 5
        $migrated.workspace.status | Should -Be "pending"
        $migrated.workspace.request | Should -BeNullOrEmpty

        $second = Invoke-StateTool -Arguments @(
            "migrate",
            "--state", $statePath,
            "--expected-revision", "5"
        )
        $second.ExitCode | Should -Be 0 -Because $second.Text
        $second.Json.result.migrated | Should -BeFalse
        $second.Json.result.stateRevision | Should -Be 5
    }

    It "never lets a migrated initial run bypass workspace preflight" {
        $state = New-TestState -Phase "resilience-analysis" -Revision 0
        $state.Remove("policyVersion")
        $state.Remove("workspace")
        $state.analysis.hypotheses = @()
        $state.analysis.selectedHypothesisId = $null
        $state.analysis.originalHypothesisId = $null
        $state.analysis.routingIntent = "select-initial"
        $state.frozenValidation = $null
        $state.faultId = $null
        $statePath = Join-Path $TestDrive "legacy-initial-state.json"
        Write-Utf8Json -Path $statePath -Value $state

        $migrate = Invoke-StateTool -Arguments @(
            "migrate",
            "--state", $statePath,
            "--expected-revision", "0"
        )
        $migrate.ExitCode | Should -Be 0 -Because $migrate.Text
        $migrated = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $migrated.workspace.status | Should -Be "pending"

        $proposalPath = Join-Path $TestDrive "legacy-initial-proposal.json"
        Write-Utf8Json -Path $proposalPath -Value @{
            contractVersion = "chaos-loop-contract/v1"
            runId = $migrated.runId
            expectedStateRevision = 1
            phase = "resilience-analysis"
            result = @{ mode = "initial"; hypotheses = @() }
        }
        $evaluate = Invoke-StateTool -Arguments @(
            "evaluate",
            "--state", $statePath,
            "--expected-revision", "1",
            "--phase", "resilience-analysis",
            "--input", $proposalPath,
            "--output", (Join-Path $TestDrive "legacy-initial-output.json")
        )

        $evaluate.ExitCode | Should -Be 2
        $evaluate.Text | Should -Match "Workspace preflight is incomplete"
    }

    It "rejects a stale revision without mutating state" {
        $state = New-TestState -Phase "resilience-analysis" -Revision 4
        $statePath = Join-Path $TestDrive "stale-state.json"
        Write-Utf8Json -Path $statePath -Value $state

        $result = Invoke-StateTool -Arguments @(
            "terminate-analysis-only",
            "--state", $statePath,
            "--expected-revision", "3"
        )

        $result.ExitCode | Should -Be 2
        $result.Text | Should -Match "Stale state revision"
        (Get-Content $statePath -Raw | ConvertFrom-Json).stateRevision | Should -Be 4
    }

    It "rejects phase output that writes another phase's handoff field" {
        $state = New-TestState -Phase "resilience-analysis" -Revision 1
        $statePath = Join-Path $TestDrive "ownership-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 1
            phase = "resilience-analysis"
            result = @{}
            handoff = @{ buildIdentity = @{ live = $true } }
            transition = @{
                status = "blocked"
                from = "resilience-analysis"
                to = "resilience-analysis"
                reason = "test"
            }
        }
        $outputPath = Join-Path $TestDrive "ownership-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $result = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "1",
            "--phase", "resilience-analysis",
            "--output", $outputPath
        )

        $result.ExitCode | Should -Be 2
        $result.Text | Should -Match "unowned handoff fields"
        (Get-Content $statePath -Raw | ConvertFrom-Json).stateRevision | Should -Be 1
    }

    It "rejects an incomplete next-phase handoff" {
        $state = New-TestState -Phase "resilience-analysis" -Revision 1
        $statePath = Join-Path $TestDrive "incomplete-handoff-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $decision = @{
            disposition = "repair"
            repairBrief = @{
                reason = "Scenario configuration is missing"
                requiredCorrections = @("Create a validated configuration")
            }
        }
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 1
            phase = "resilience-analysis"
            result = @{
                mode = "initial"
                analysisHandoff = $decision
            }
            handoff = @{ analysisDecision = $decision }
            transition = @{
                status = "ready"
                from = "resilience-analysis"
                to = "resilience-analysis"
                reason = "repair"
            }
        }
        $outputPath = Join-Path $TestDrive "incomplete-handoff-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $result = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "1",
            "--phase", "resilience-analysis",
            "--output", $outputPath
        )

        $result.ExitCode | Should -Be 2
        $result.Text | Should -Match "handoff is incomplete"
    }

    It "rejects a phase-created routine blocked transition" {
        $state = New-TestState -Phase "resilience-analysis" -Revision 1
        $statePath = Join-Path $TestDrive "blocked-output-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $decision = @{
            disposition = "repair"
            repairBrief = @{
                reason = "Scenario configuration is missing"
                requiredCorrections = @("Create a validated configuration")
            }
        }
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 1
            phase = "resilience-analysis"
            result = @{
                mode = "initial"
                analysisHandoff = $decision
            }
            handoff = @{
                analysisDecision = $decision
                unresolvedCaveats = @()
            }
            transition = @{
                status = "blocked"
                from = "resilience-analysis"
                to = "resilience-analysis"
                reason = "ask customer"
            }
        }
        $outputPath = Join-Path $TestDrive "blocked-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $result = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "1",
            "--phase", "resilience-analysis",
            "--output", $outputPath
        )

        $result.ExitCode | Should -Be 2
        $result.Text | Should -Match "phases cannot create interaction blocks"
    }

    It "rejects verification fault drift without mutating the frozen fault" {
        $state = New-TestState -Phase "chaos-execution" -Revision 2
        $state.analysis.mode = "reassess"
        $state.analysis.routingIntent = "reassess-identical"
        $statePath = Join-Path $TestDrive "drift-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $drifted = Copy-JsonObject $state.frozenValidation
        $drifted.duration = "PT10M"
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 2
            phase = "chaos-execution"
            result = @{
                mode = "verify"
                frozenValidation = $drifted
                executionHandoff = @{
                    disposition = "diagnostic-eligible"
                    diagnosticEligible = $true
                    repairBrief = $null
                    evidence = @()
                }
                testIdentity = @{}
                buildIdentity = @{ live = $true }
                steadyStateEvidence = @{ passed = $true }
                faultEvidence = @{ faultLanded = $true; evidence = @("action active") }
                faultWindow = @{
                    startTime = "2026-08-13T19:00:00Z"
                    endTime = "2026-08-13T19:05:00Z"
                }
                run = @{ status = "completed"; recoveryEvidence = @("recovered") }
            }
            handoff = @{
                executionDecision = @{
                    disposition = "diagnostic-eligible"
                    diagnosticEligible = $true
                    repairBrief = $null
                    evidence = @()
                }
                testIdentity = @{}
                buildIdentity = @{ live = $true }
                steadyStateEvidence = @{ passed = $true }
                faultWindow = @{
                    startTime = "2026-08-13T19:00:00Z"
                    endTime = "2026-08-13T19:05:00Z"
                }
                provingFaultEvidence = @{ faultLanded = $true; evidence = @("action active") }
                unresolvedCaveats = @()
            }
            transition = @{
                status = "ready"
                from = "chaos-execution"
                to = "diagnostic"
                reason = "complete"
            }
        }
        $outputPath = Join-Path $TestDrive "drift-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $result = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "2",
            "--phase", "chaos-execution",
            "--output", $outputPath
        )

        $result.ExitCode | Should -Be 2
        $result.Text | Should -Match "drifted from frozenValidation"
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.frozenValidation.duration | Should -Be "PT5M"
        $observed.stateRevision | Should -Be 2
    }

    It "auto-routes a correctable execution failure to Analysis with a repair handoff" {
        $state = New-TestState -Phase "chaos-execution" -Revision 2
        $statePath = Join-Path $TestDrive "execution-repair-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $decision = @{
            disposition = "repair-analysis"
            diagnosticEligible = $false
            repairBrief = @{
                failureClass = "build-identity"
                reason = "Observed revision does not match the intended build"
                evidence = @("revision orders--000041")
                requiredCorrections = @("Deploy the expected revision")
            }
            evidence = @("revision orders--000041")
        }
        $resultValues = @{
            testIdentity = @{}
            buildIdentity = @{ live = $false }
            steadyStateEvidence = @{ passed = $false }
            faultWindow = $null
            faultEvidence = @{}
        }
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 2
            phase = "chaos-execution"
            result = @{
                mode = "initial"
                frozenValidation = $state.frozenValidation
                executionHandoff = $decision
                testIdentity = $resultValues.testIdentity
                buildIdentity = $resultValues.buildIdentity
                steadyStateEvidence = $resultValues.steadyStateEvidence
                faultWindow = $resultValues.faultWindow
                faultEvidence = $resultValues.faultEvidence
            }
            handoff = @{
                executionDecision = $decision
                testIdentity = $resultValues.testIdentity
                buildIdentity = $resultValues.buildIdentity
                steadyStateEvidence = $resultValues.steadyStateEvidence
                faultWindow = $resultValues.faultWindow
                provingFaultEvidence = $resultValues.faultEvidence
                unresolvedCaveats = @()
            }
            transition = @{
                status = "ready"
                from = "chaos-execution"
                to = "resilience-analysis"
                reason = "repair build identity"
            }
        }
        $outputPath = Join-Path $TestDrive "execution-repair-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $apply = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "2",
            "--phase", "chaos-execution",
            "--output", $outputPath
        )

        $apply.ExitCode | Should -Be 0 -Because $apply.Text
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.phase | Should -Be "resilience-analysis"
        $observed.transition.status | Should -Be "ready"
        $observed.analysis.routingIntent | Should -Be "repair-exercise"
        $observed.handoff.executionDecision.repairBrief.failureClass |
            Should -Be "build-identity"
    }

    It "routes NOT EXERCISED back to analysis and never to advisory" {
        $state = New-TestState -Phase "diagnostic" -Revision 3
        $statePath = Join-Path $TestDrive "not-exercised-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $hypothesisResult = @{
            hypothesisId = "H1"
            workStarvationChecked = $true
            eligibleWorkObserved = $false
            changedCodePathObserved = $null
            verdict = "NOT EXERCISED"
            reason = "No eligible work reached the target path"
        }
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 3
            phase = "diagnostic"
            result = @{
                mode = "initial"
                numericBaselines = @()
                observedSLIs = @()
                telemetryQueries = @()
                starvationEvidence = @{}
                dlqState = @()
                hypothesisResults = @($hypothesisResult)
                diagnosticHandoff = @{
                    hypothesisId = "H1"
                    verdict = "NOT EXERCISED"
                    route = "exercise-repair"
                    nextPhase = "resilience-analysis"
                    exerciseRepairBrief = @{
                        reason = "No eligible work reached the target path"
                        requiredCorrections = @("Generate eligible work")
                    }
                }
                boundedCritique = @{
                    critiqueCount = 1
                    rewriteCount = 1
                    checks = @("schema", "starvation")
                    corrections = @()
                }
                fixableConfirmedHypothesisIds = @()
                sloHolds = $false
            }
            handoff = @{
                diagnosticDecision = @{
                    hypothesisId = "H1"
                    verdict = "NOT EXERCISED"
                    route = "exercise-repair"
                    nextPhase = "resilience-analysis"
                    exerciseRepairBrief = @{
                        reason = "No eligible work reached the target path"
                        requiredCorrections = @("Generate eligible work")
                    }
                }
                numericBaselines = @()
                observedSLIs = @()
                telemetryQueries = @()
                starvationEvidence = @{}
                hypothesisResults = @($hypothesisResult)
                targetedPathEvidence = @()
                changedPathEvidence = @()
                dlqState = @()
                unresolvedCaveats = @()
            }
            transition = @{
                status = "ready"
                from = "diagnostic"
                to = "resilience-analysis"
                reason = "exercise repair required"
            }
        }
        $outputPath = Join-Path $TestDrive "not-exercised-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $result = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "3",
            "--phase", "diagnostic",
            "--output", $outputPath
        )

        $result.ExitCode | Should -Be 0 -Because $result.Text
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.phase | Should -Be "resilience-analysis"
        $observed.analysis.routingIntent | Should -Be "repair-exercise"
        $observed.transition.to | Should -Be "resilience-analysis"
        $observed.stateRevision | Should -Be 4
    }

    It "keeps a verify NOT EXERCISED repair in reassess mode" {
        $state = New-TestState -Phase "diagnostic" -Revision 8
        $state.analysis.mode = "reassess"
        $state.analysis.routingIntent = "selected-verification"
        $state.iteration = 1
        $statePath = Join-Path $TestDrive "verify-not-exercised-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $hypothesisResult = @{
            hypothesisId = "H1"
            workStarvationChecked = $true
            eligibleWorkObserved = $true
            changedCodePathObserved = $false
            verdict = "NOT EXERCISED"
            reason = "Changed path was not observed"
        }
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 8
            phase = "diagnostic"
            result = @{
                mode = "verify"
                numericBaselines = @()
                observedSLIs = @()
                telemetryQueries = @()
                starvationEvidence = @{}
                dlqState = @()
                hypothesisResults = @($hypothesisResult)
                diagnosticHandoff = @{
                    hypothesisId = "H1"
                    verdict = "NOT EXERCISED"
                    route = "exercise-repair"
                    nextPhase = "resilience-analysis"
                    exerciseRepairBrief = @{
                        reason = "Changed path was not observed"
                        requiredCorrections = @("Exercise the changed path")
                    }
                }
                boundedCritique = @{
                    critiqueCount = 1
                    rewriteCount = 1
                    checks = @("schema", "changed-path-proof")
                    corrections = @()
                }
                fixableConfirmedHypothesisIds = @()
                sloHolds = $true
                unresolvedCaveats = @()
            }
            handoff = @{
                diagnosticDecision = @{
                    hypothesisId = "H1"
                    verdict = "NOT EXERCISED"
                    route = "exercise-repair"
                    nextPhase = "resilience-analysis"
                    exerciseRepairBrief = @{
                        reason = "Changed path was not observed"
                        requiredCorrections = @("Exercise the changed path")
                    }
                }
                numericBaselines = @()
                observedSLIs = @()
                telemetryQueries = @()
                starvationEvidence = @{}
                dlqState = @()
                hypothesisResults = @($hypothesisResult)
                targetedPathEvidence = @()
                changedPathEvidence = @()
                unresolvedCaveats = @()
            }
            transition = @{
                status = "ready"
                from = "diagnostic"
                to = "resilience-analysis"
                reason = "verify exercise repair required"
            }
        }
        $outputPath = Join-Path $TestDrive "verify-not-exercised-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $result = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "8",
            "--phase", "diagnostic",
            "--output", $outputPath
        )

        $result.ExitCode | Should -Be 0 -Because $result.Text
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.phase | Should -Be "resilience-analysis"
        $observed.analysis.mode | Should -Be "reassess"
        $observed.analysis.routingIntent | Should -Be "repair-verify-exercise"
        $observed.iteration | Should -Be 1
    }

    It "terminates escalated when verify REFUTED but the SLO still fails" {
        $state = New-TestState -Phase "diagnostic" -Revision 9
        $state.analysis.mode = "reassess"
        $state.analysis.routingIntent = "selected-verification"
        $state.iteration = 1
        $statePath = Join-Path $TestDrive "verify-refuted-slo-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $hypothesisResult = @{
            hypothesisId = "H1"
            provingFault = @{ satisfied = $true; evidence = @("action active") }
            workStarvationChecked = $true
            eligibleWorkObserved = $true
            executedCodePathEvidence = @("worker span")
            changedCodePathObserved = $true
            confirmPredicate = @{
                telemetryQuery = "jobs | where failed | count"
                observedValue = 0
                evaluatedTrue = $false
            }
            verdict = "REFUTED"
            reason = "Fault predicate refuted but service SLO remained breached"
        }
        $decision = @{
            hypothesisId = "H1"
            verdict = "REFUTED"
            route = "escalated"
            nextPhase = "terminated"
            exerciseRepairBrief = $null
            reason = $hypothesisResult.reason
        }
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 9
            phase = "diagnostic"
            result = @{
                mode = "verify"
                numericBaselines = @()
                observedSLIs = @()
                telemetryQueries = @()
                starvationEvidence = @{}
                dlqState = @()
                hypothesisResults = @($hypothesisResult)
                diagnosticHandoff = $decision
                boundedCritique = @{
                    critiqueCount = 1
                    rewriteCount = 1
                    checks = @("schema", "changed-path-proof")
                }
                fixableConfirmedHypothesisIds = @()
                sloHolds = $false
                unresolvedCaveats = @()
            }
            handoff = @{
                diagnosticDecision = $decision
                numericBaselines = @()
                observedSLIs = @()
                telemetryQueries = @()
                starvationEvidence = @{}
                hypothesisResults = @($hypothesisResult)
                targetedPathEvidence = @()
                changedPathEvidence = @("changed worker span")
                dlqState = @()
                unresolvedCaveats = @()
            }
            transition = @{
                status = "terminated"
                from = "diagnostic"
                to = "terminated"
                reason = "SLO remains breached"
            }
        }
        $outputPath = Join-Path $TestDrive "verify-refuted-slo-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $apply = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "9",
            "--phase", "diagnostic",
            "--output", $outputPath
        )

        $apply.ExitCode | Should -Be 0 -Because $apply.Text
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.phase | Should -Be "terminated"
        $observed.terminationReason | Should -Be "escalated"
    }

    It "creates the advisory-approval interaction stop and auto-runs Coding after selection" {
        $state = New-TestState -Phase "advisory" -Revision 4
        $confirmed = @{
            hypothesisId = "H1"
            verdict = "CONFIRMED"
        }
        $state.handoff.hypothesisResults = @($confirmed)
        $statePath = Join-Path $TestDrive "advisory-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $advisory = @{
            advisoryId = "A1"
            rank = 1
            title = "Bound worker concurrency"
            addressesHypothesisIds = @("H1")
            evidence = @{
                diagnosticQuery = "jobs | where failed | count"
            }
            grounding = @{
                citation = "Azure Well-Architected reliability guidance"
            }
            acceptanceEvidence = @{
                changedCodePathPredicate = "bounded worker span observed"
            }
            approvalStatus = "proposed"
        }
        $ledger = @{
            previousSetId = $null
            currentSetId = "set-1"
            added = @(@{ advisoryId = "A1" })
            changed = @()
            unchanged = @()
            removed = @()
        }
        $advisoryState = @{
            previousSetId = $null
            currentSetId = "set-1"
            defaultRecommendedAdvisoryIds = @("A1")
            advisories = @($advisory)
            changeLedger = $ledger
        }
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 4
            phase = "advisory"
            result = @{
                advisories = @($advisory)
                changeLedger = $ledger
                defaultRecommendedAdvisoryIds = @("A1")
                boundedCritique = @{
                    critiqueCount = 1
                    rewriteCount = 1
                    checks = @("evidence-linkage", "ledger-completeness")
                }
            }
            handoff = @{
                advisoryState = $advisoryState
                unresolvedCaveats = @()
            }
            transition = @{
                status = "ready"
                from = "advisory"
                to = "advisory-approval"
                reason = "ranked recommendation ready"
            }
        }
        $outputPath = Join-Path $TestDrive "advisory-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $apply = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "4",
            "--phase", "advisory",
            "--output", $outputPath
        )
        $apply.ExitCode | Should -Be 0 -Because $apply.Text
        $paused = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $paused.phase | Should -Be "advisory-approval"
        $paused.transition.status | Should -Be "blocked"
        $paused.handoff.advisoryState.defaultRecommendedAdvisoryIds | Should -Be @("A1")

        $approve = Invoke-StateTool -Arguments @(
            "approve",
            "--state", $statePath,
            "--expected-revision", "5",
            "--advisory-ids", "A1"
        )
        $approve.ExitCode | Should -Be 0 -Because $approve.Text
        $resumed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $resumed.phase | Should -Be "coding"
        $resumed.transition.status | Should -Be "ready"
        $resumed.transition.to | Should -Be "coding"
    }

    It "rejects blocked state outside the two interaction phases" {
        $state = New-TestState -Phase "diagnostic" -Revision 2
        $state.transition = @{
            status = "blocked"
            from = "diagnostic"
            to = "diagnostic"
            reason = "routine confirmation"
        }
        $statePath = Join-Path $TestDrive "invalid-blocked-state.json"
        Write-Utf8Json -Path $statePath -Value $state

        $result = Invoke-StateTool -Arguments @("status", "--state", $statePath)

        $result.ExitCode | Should -Be 2
        $result.Text | Should -Match "Only advisory-approval and awaiting-external-gate may block"
    }

    It "stops coding at the hard external gate" {
        $state = New-TestState -Phase "coding" -Revision 5
        $state.approvedAdvisoryIds = @("A1")
        $statePath = Join-Path $TestDrive "coding-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $implemented = @{
            changeId = "C1"
            advisoryIds = @("A1")
            hypothesisIds = @("H1")
            class = "application code"
            prUrl = "https://github.com/contoso/orders/pull/42"
            repo = "contoso/orders"
            branch = "fix/bounded-worker"
            commit = "abcdef1"
            filesChanged = @("src/Worker.cs")
            coherenceReason = "One bounded concurrency change"
            targetEnv = "staging"
            expectedBuildId = "build-8421"
            expectedArtifact = "sha256:abc123"
            expectedDeploymentId = "deploy-771"
            expectedRevision = "orders--000042"
            acceptanceEvidence = @{
                changedCodePathPredicate = "bounded path span observed"
                validationHypothesisId = "H1"
                requiredTelemetry = @("Worker.Bounded span")
            }
            verification = @{
                hostedRunnersEnabled = $false
                verificationStatus = "passed"
                pathsRun = @(
                    @{
                        type = "local"
                        commandOrService = "dotnet test"
                        result = "passed"
                        evidence = "10 tests passed"
                    }
                )
                notProofOfResilience = $true
            }
        }
        $output = @{
            evaluation = New-EvaluationStamp
            contractVersion = "chaos-loop-contract/v1"
            runId = $state.runId
            expectedStateRevision = 5
            phase = "coding"
            result = @{
                approvedAdvisoryIds = @("A1")
                implemented = @($implemented)
                notImplemented = @()
            }
            handoff = @{
                codeChanges = @{
                    implemented = @($implemented)
                    notImplemented = @()
                    deliveryDecision = @{
                        route = "awaiting-external-gate"
                        prUrls = @("https://github.com/contoso/orders/pull/42")
                        requiredGateEvidence = @(
                            "merge",
                            "build",
                            "artifact",
                            "deployment",
                            "serving-revision"
                        )
                    }
                }
                unresolvedCaveats = @()
            }
            transition = @{
                status = "ready"
                from = "coding"
                to = "awaiting-external-gate"
                reason = "PR created"
            }
        }
        $outputPath = Join-Path $TestDrive "coding-output.json"
        Write-Utf8Json -Path $outputPath -Value $output

        $result = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "5",
            "--phase", "coding",
            "--output", $outputPath
        )

        $result.ExitCode | Should -Be 0 -Because $result.Text
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.phase | Should -Be "awaiting-external-gate"
        $observed.transition.status | Should -Be "blocked"
        $observed.transition.to | Should -Be "awaiting-external-gate"
        $observed.iteration | Should -Be 0
    }

    It "rejects a gate identity mismatch and leaves the run blocked" {
        $state = New-TestState -Phase "awaiting-external-gate" -Revision 6
        $implemented = @{
            changeId = "C1"
            prUrl = "https://github.com/contoso/orders/pull/42"
            targetEnv = "staging"
        }
        $state.handoff.codeChanges.implemented = @($implemented)
        $state.attemptedFixes = @($implemented)
        $state.transition = @{
            status = "blocked"
            from = "coding"
            to = "awaiting-external-gate"
            reason = "external proof required"
        }
        $statePath = Join-Path $TestDrive "gate-mismatch-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $gate = Get-Content $script:gateExample -Raw | ConvertFrom-Json -AsHashtable
        $gate.runId = $state.runId
        $gate.expectedStateRevision = 6
        $gate.changes[0].observedArtifact = "sha256:different"
        $gatePath = Join-Path $TestDrive "gate-mismatch.json"
        Write-Utf8Json -Path $gatePath -Value $gate

        $result = Invoke-StateTool -Arguments @(
            "resume",
            "--state", $statePath,
            "--expected-revision", "6",
            "--gate", $gatePath
        )

        $result.ExitCode | Should -Be 2
        $result.Text | Should -Match "expectedArtifact/observedArtifact mismatch"
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.phase | Should -Be "awaiting-external-gate"
        $observed.stateRevision | Should -Be 6
        $observed.iteration | Should -Be 0
    }

    It "accepts a complete gate and resumes reassessment without changing the frozen fault" {
        $state = New-TestState -Phase "awaiting-external-gate" -Revision 6
        $implemented = @{
            changeId = "C1"
            prUrl = "https://github.com/contoso/orders/pull/42"
            targetEnv = "staging"
        }
        $state.handoff.codeChanges.implemented = @($implemented)
        $state.attemptedFixes = @((Copy-JsonObject $implemented))
        $state.transition = @{
            status = "blocked"
            from = "coding"
            to = "awaiting-external-gate"
            reason = "external proof required"
        }
        $statePath = Join-Path $TestDrive "gate-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $gate = Get-Content $script:gateExample -Raw | ConvertFrom-Json -AsHashtable
        $gate.runId = $state.runId
        $gate.expectedStateRevision = 6
        $gatePath = Join-Path $TestDrive "gate.json"
        Write-Utf8Json -Path $gatePath -Value $gate

        $result = Invoke-StateTool -Arguments @(
            "resume",
            "--state", $statePath,
            "--expected-revision", "6",
            "--gate", $gatePath
        )

        $result.ExitCode | Should -Be 0 -Because $result.Text
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.phase | Should -Be "resilience-analysis"
        $observed.analysis.mode | Should -Be "reassess"
        $observed.analysis.routingIntent | Should -Be "reassess-identical"
        $observed.iteration | Should -Be 1
        $observed.stateRevision | Should -Be 7
        $observed.frozenValidation.duration | Should -Be "PT5M"
        $observed.attemptedFixes[0].externalGate.observedRevision | Should -Be "orders--000042"
    }

    It "accepts a later-iteration gate without re-gating prior attempts" {
        $state = New-TestState -Phase "awaiting-external-gate" -Revision 12
        $state.iteration = 1
        $prior = @{
            changeId = "C1"
            prUrl = "https://github.com/contoso/orders/pull/41"
            targetEnv = "staging"
            externalGate = @{ observedRevision = "orders--000041" }
        }
        $current = @{
            changeId = "C2"
            prUrl = "https://github.com/contoso/orders/pull/42"
            targetEnv = "staging"
        }
        $state.handoff.codeChanges.implemented = @($current)
        $state.attemptedFixes = @($prior, $current)
        $state.transition = @{
            status = "blocked"
            from = "coding"
            to = "awaiting-external-gate"
            reason = "external proof required"
        }
        $statePath = Join-Path $TestDrive "second-gate-state.json"
        Write-Utf8Json -Path $statePath -Value $state
        $gate = Get-Content $script:gateExample -Raw | ConvertFrom-Json -AsHashtable
        $gate.runId = $state.runId
        $gate.expectedStateRevision = 12
        $gate.changes[0].changeId = "C2"
        $gatePath = Join-Path $TestDrive "second-gate.json"
        Write-Utf8Json -Path $gatePath -Value $gate

        $result = Invoke-StateTool -Arguments @(
            "resume",
            "--state", $statePath,
            "--expected-revision", "12",
            "--gate", $gatePath
        )

        $result.ExitCode | Should -Be 0 -Because $result.Text
        $observed = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $observed.iteration | Should -Be 2
        $observed.attemptedFixes[0].externalGate.observedRevision |
            Should -Be "orders--000041"
        $observed.attemptedFixes[1].externalGate.observedRevision |
            Should -Be "orders--000042"
    }
}
