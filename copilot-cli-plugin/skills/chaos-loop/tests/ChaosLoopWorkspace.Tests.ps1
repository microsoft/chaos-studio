Describe "Chaos Loop workspace preflight" {
    BeforeAll {
        $script:pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." ".." "..")).Path
        $script:stateTool = Join-Path $script:pluginRoot "scripts" "chaos_loop_state.py"
        $script:planSchema = Join-Path $script:pluginRoot "schemas" "chaos-loop" "workspace-plan.v1.schema.json"
        $script:stateSchema = Join-Path $script:pluginRoot "schemas" "chaos-loop" "run-state.v1.schema.json"
        $script:planExample = Join-Path $script:pluginRoot "examples" "chaos-loop" "workspace-plan.json"
        $script:subscription = "8f4a2b1c-6d3e-4f57-9a80-1b2c3d4e5f60"
        $script:otherSubscription = "0d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6"
        $script:resourceGroup = "rg-orders"
        $script:target = "/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)/providers/Microsoft.Web/sites/orders"

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
                $Value
            )

            $json = $Value | ConvertTo-Json -Depth 100
            [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine)
        }

        function New-WorkspaceResource {
            param(
                [Parameter(Mandatory)][string]$Name,
                [string]$ResourceGroup = $script:resourceGroup,
                [string]$Subscription = $script:subscription,
                [string]$Location = "eastus",
                [string[]]$Scopes,
                [string]$ProvisioningState = "Succeeded",
                [hashtable]$Identity
            )

            if (-not $Scopes) {
                $Scopes = @("/subscriptions/$Subscription/resourceGroups/$ResourceGroup")
            }
            if (-not $Identity) {
                $Identity = @{ type = "SystemAssigned"; principalId = "3d2f8c11-9b74-4a1e-8c55-0a9f7b6e4d21" }
            }
            return @{
                id = "/subscriptions/$Subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Chaos/workspaces/$Name"
                name = $Name
                type = "Microsoft.Chaos/workspaces"
                location = $Location
                identity = $Identity
                properties = @{
                    provisioningState = $ProvisioningState
                    scopes = @($Scopes)
                }
            }
        }

        function New-Discovery {
            param(
                [object[]]$Workspaces = @(),
                [string]$ResourceGroup = $script:resourceGroup
            )
            return @{
                ok = $true
                result = @{
                    workspaces = @($Workspaces)
                    count = @($Workspaces).Count
                    scope = "resourceGroup"
                    resourceGroup = $ResourceGroup
                }
            }
        }

        function Start-PreflightRun {
            param(
                [Parameter(Mandatory)][string]$Name,
                [hashtable]$Request,
                [string[]]$Targets
            )

            if (-not $Request) {
                $Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @("/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)")
                }
            }
            if (-not $Targets) {
                $Targets = @($script:target)
            }
            $root = Join-Path $TestDrive $Name
            $result = Invoke-StateTool -Arguments @(
                "start",
                "--repo", "contoso/orders",
                "--commit", "abc123",
                "--target-resources", ($Targets | ConvertTo-Json -Compress -AsArray),
                "--guardrails", '{"environmentScope":"staging","blastRadiusCap":"one replica","safetyHalts":["availability below 95%"]}',
                "--workspace-request", ($Request | ConvertTo-Json -Depth 20 -Compress),
                "--state-root", $root
            )
            return $result
        }

        function Invoke-Plan {
            param(
                [Parameter(Mandatory)][string]$Name,
                [Parameter(Mandatory)][string]$StatePath,
                [Parameter(Mandatory)]$Discovery,
                [int]$Revision = 0,
                [string]$ObservedAt = "2026-08-14T10:00:00Z"
            )

            $discoveryPath = Join-Path $TestDrive "$Name-discovery.json"
            $planPath = Join-Path $TestDrive "$Name-plan.json"
            Write-Utf8Json -Path $discoveryPath -Value $Discovery
            $result = Invoke-StateTool -Arguments @(
                "workspace-plan",
                "--state", $StatePath,
                "--expected-revision", "$Revision",
                "--discovery", $discoveryPath,
                "--observed-at", $ObservedAt,
                "--output", $planPath
            )
            $result.PlanPath = $planPath
            return $result
        }

        function Invoke-Finalize {
            param(
                [Parameter(Mandatory)][string]$Name,
                [Parameter(Mandatory)][string]$StatePath,
                [Parameter(Mandatory)][string]$PlanPath,
                [Parameter(Mandatory)]$Result,
                [int]$Revision = 0
            )

            $resultPath = Join-Path $TestDrive "$Name-result.json"
            Write-Utf8Json -Path $resultPath -Value $Result
            return Invoke-StateTool -Arguments @(
                "workspace-finalize",
                "--state", $StatePath,
                "--expected-revision", "$Revision",
                "--plan", $PlanPath,
                "--result", $resultPath
            )
        }
    }

    It "validates the checked-in workspace plan example against the versioned schema" {
        $json = Get-Content $script:planExample -Raw
        $json | Test-Json -SchemaFile $script:planSchema | Should -BeTrue
    }

    It "reuses an existing compatible workspace and reads it back" {
        $start = Start-PreflightRun -Name "reuse"
        $start.ExitCode | Should -Be 0 -Because $start.Text
        $statePath = $start.Json.result.statePath

        $existing = New-WorkspaceResource -Name "orders-resilience"
        $plan = Invoke-Plan -Name "reuse" -StatePath $statePath -Discovery (New-Discovery -Workspaces @($existing))
        $plan.ExitCode | Should -Be 0 -Because $plan.Text
        $plan.Json.result.plan.decision | Should -Be "reuse"
        $plan.Json.result.plan.selected.name | Should -Be "orders-resilience"
        $plan.Json.result.plan.createRequest | Should -BeNullOrEmpty
        (Get-Content $plan.PlanPath -Raw) | Test-Json -SchemaFile $script:planSchema | Should -BeTrue

        # The plan must not mutate state.
        (Get-Content $statePath -Raw | ConvertFrom-Json).stateRevision | Should -Be 0
        (Get-Content $statePath -Raw | ConvertFrom-Json).workspace.status | Should -Be "pending"

        $final = Invoke-Finalize -Name "reuse" -StatePath $statePath -PlanPath $plan.PlanPath `
            -Result @{ ok = $true; result = $existing }
        $final.ExitCode | Should -Be 0 -Because $final.Text
        $final.Json.result.workspaceStatus | Should -Be "ready"

        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $state.workspace.status | Should -Be "ready"
        $state.workspace.decision | Should -Be "reused"
        $state.workspace.selected.id | Should -Be $existing.id
        $state.workspace.selected.provisioningState | Should -Be "Succeeded"
        $state.workspace.discoveryEvidence.source | Should -Be "chaos_list_workspaces"
        $state.workspace.provisioningEvidence.source | Should -Be "chaos_get_workspace"
        ([datetime]$state.workspace.observedAt).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") |
            Should -Be "2026-08-14T10:00:00Z"
        $state.workspace.remediationBrief | Should -BeNullOrEmpty
        $state.phase | Should -Be "resilience-analysis"
        $state.verdict | Should -Be "in-progress"
        (Get-Content $statePath -Raw) | Test-Json -SchemaFile $script:stateSchema | Should -BeTrue
    }

    It "plans a deterministic create request when no candidate is compatible" {
        $start = Start-PreflightRun -Name "create"
        $statePath = $start.Json.result.statePath
        $wrongRegion = New-WorkspaceResource -Name "ws-westus" -Location "westus"
        $wrongScope = New-WorkspaceResource -Name "ws-otherrg" -Scopes @(
            "/subscriptions/$($script:subscription)/resourceGroups/rg-unrelated"
        )
        $notProvisioned = New-WorkspaceResource -Name "ws-failed" -ProvisioningState "Failed"

        $plan = Invoke-Plan -Name "create" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($wrongRegion, $wrongScope, $notProvisioned))
        $plan.ExitCode | Should -Be 0 -Because $plan.Text
        $plan.Json.result.plan.decision | Should -Be "create"
        $plan.Json.result.plan.selected | Should -BeNullOrEmpty
        $plan.Json.result.plan.createRequest.location | Should -Be "eastus"
        $plan.Json.result.plan.createRequest.resourceGroup | Should -Be $script:resourceGroup
        $plan.Json.result.plan.createRequest.scopes | Should -Be @(
            "/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)"
        )
        $plan.Json.result.plan.createRequest.identity.type | Should -Be "SystemAssigned"
        $plan.Json.result.plan.createRequest.workspaceName | Should -Match "^chaos-loop-[0-9a-f]{12}$"
        $plan.Json.result.plan.discoveryEvidence.rejected.Count | Should -Be 3

        # The generated name is a pure function of the validated request.
        $second = Invoke-Plan -Name "create-again" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($wrongRegion))
        $second.Json.result.plan.createRequest.workspaceName |
            Should -Be $plan.Json.result.plan.createRequest.workspaceName

        $created = New-WorkspaceResource -Name $plan.Json.result.plan.createRequest.workspaceName
        $final = Invoke-Finalize -Name "create" -StatePath $statePath -PlanPath $plan.PlanPath -Result @{
            ok = $true
            result = @{
                workspace = $created
                roleAssignments = @(
                    @{
                        scope = "/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)"
                        status = "granted"
                    }
                )
            }
        }
        $final.ExitCode | Should -Be 0 -Because $final.Text
        $final.Json.result.workspaceStatus | Should -Be "ready"

        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $state.workspace.decision | Should -Be "created"
        $state.workspace.selected.name | Should -Be $created.name
        $state.workspace.provisioningEvidence.source | Should -Be "chaos_create_workspace"
        $state.workspace.provisioningEvidence.roleAssignments[0].status | Should -Be "granted"
    }

    It "does not overwrite an incompatible workspace with the preferred name" {
        $request = @{
            subscriptionId = $script:subscription
            resourceGroup = $script:resourceGroup
            location = "eastus"
            managedScopes = @(
                "/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)"
            )
            preferredName = "orders-resilience"
        }
        $start = Start-PreflightRun -Name "preferred-collision" -Request $request
        $statePath = $start.Json.result.statePath
        $incompatible = New-WorkspaceResource -Name "orders-resilience" -Scopes @(
            "/subscriptions/$($script:subscription)/resourceGroups/rg-unrelated"
        )

        $plan = Invoke-Plan -Name "preferred-collision" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($incompatible))

        $plan.ExitCode | Should -Be 0 -Because $plan.Text
        $plan.Json.result.plan.decision | Should -Be "create"
        $plan.Json.result.plan.createRequest.workspaceName | Should -Match "^chaos-loop-[0-9a-f]{12}$"
        $plan.Json.result.plan.createRequest.workspaceName | Should -Not -Be "orders-resilience"
        ($plan.Json.result.plan.caveats -join " ") | Should -Match "already exists but is incompatible"
    }

    It "rejects discovery from a resource group other than the requested one" {
        $start = Start-PreflightRun -Name "wrong-discovery-scope"
        $statePath = $start.Json.result.statePath

        $plan = Invoke-Plan -Name "wrong-discovery-scope" -StatePath $statePath `
            -Discovery (New-Discovery -ResourceGroup "rg-other")

        $plan.ExitCode | Should -Be 2
        $plan.Text | Should -Match "does not match requested"
        (Get-Content $statePath -Raw | ConvertFrom-Json).workspace.status | Should -Be "pending"
    }

    It "selects the same workspace on every run when several candidates match" {
        $request = @{
            subscriptionId = $script:subscription
            resourceGroup = $script:resourceGroup
            location = "eastus"
            managedScopes = @("/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)")
            preferredName = "orders-preferred"
        }
        $start = Start-PreflightRun -Name "stable" -Request $request
        $start.ExitCode | Should -Be 0 -Because $start.Text
        $statePath = $start.Json.result.statePath

        $broad = New-WorkspaceResource -Name "aaa-broad" -Scopes @("/subscriptions/$($script:subscription)")
        $exactB = New-WorkspaceResource -Name "bbb-exact"
        $exactA = New-WorkspaceResource -Name "aaa-exact"
        $preferred = New-WorkspaceResource -Name "orders-preferred" -Scopes @("/subscriptions/$($script:subscription)")

        $withPreferred = Invoke-Plan -Name "stable-preferred" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($broad, $exactB, $preferred, $exactA))
        $withPreferred.ExitCode | Should -Be 0 -Because $withPreferred.Text
        $withPreferred.Json.result.plan.selected.name | Should -Be "orders-preferred"
        $withPreferred.Json.result.plan.alternatives.Count | Should -Be 3
        ($withPreferred.Json.result.plan.caveats -join " ") | Should -Match "deterministic selection precedence"

        # Same candidate set in a different order returns the same selection.
        $reordered = Invoke-Plan -Name "stable-reordered" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($exactA, $preferred, $broad, $exactB))
        $reordered.Json.result.plan.selected.id | Should -Be $withPreferred.Json.result.plan.selected.id

        # Without the preferred name, the exact managed-scope set wins, then the ARM ID.
        $noPreferred = Start-PreflightRun -Name "stable-no-preferred"
        $noPreferredState = $noPreferred.Json.result.statePath
        $tie = Invoke-Plan -Name "stable-tie" -StatePath $noPreferredState `
            -Discovery (New-Discovery -Workspaces @($broad, $exactB, $exactA))
        $tie.Json.result.plan.selected.name | Should -Be "aaa-exact"
        ($tie.Json.result.plan.caveats -join " ") | Should -Not -Match "broader scope"
    }

    It "records a caveat when the reused workspace manages a broader scope set" {
        $start = Start-PreflightRun -Name "broader"
        $statePath = $start.Json.result.statePath
        $broad = New-WorkspaceResource -Name "ws-broad" -Scopes @("/subscriptions/$($script:subscription)")
        $plan = Invoke-Plan -Name "broader" -StatePath $statePath -Discovery (New-Discovery -Workspaces @($broad))

        $plan.Json.result.plan.decision | Should -Be "reuse"
        ($plan.Json.result.plan.caveats -join " ") | Should -Match "broader scope set than requested"

        $final = Invoke-Finalize -Name "broader" -StatePath $statePath -PlanPath $plan.PlanPath `
            -Result @{ ok = $true; result = $broad }
        $final.ExitCode | Should -Be 0 -Because $final.Text
        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        ($state.workspace.caveats -join " ") | Should -Match "broader scope set than requested"
    }

    It "rejects invalid, ambiguous, and out-of-subscription scopes at start" {
        $cases = @(
            @{
                Name = "management-group"
                Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @("/providers/Microsoft.Management/managementGroups/contoso")
                }
                Targets = @($script:target)
                Pattern = "subscription-rooted ARM ID"
            },
            @{
                Name = "foreign-subscription-scope"
                Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @("/subscriptions/$($script:otherSubscription)/resourceGroups/$($script:resourceGroup)")
                }
                Targets = @($script:target)
                Pattern = "outside the requested subscription"
            },
            @{
                Name = "uncovered-target"
                Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @("/subscriptions/$($script:subscription)/resourceGroups/rg-unrelated")
                }
                Targets = @($script:target)
                Pattern = "not covered by any requested managed scope"
            },
            @{
                Name = "empty-scopes"
                Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @()
                }
                Targets = @($script:target)
                Pattern = "managedScopes must be a non-empty array"
            },
            @{
                Name = "bad-subscription"
                Request = @{
                    subscriptionId = "000"
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @("/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)")
                }
                Targets = @($script:target)
                Pattern = "subscriptionId must be an Azure subscription UUID"
            },
            @{
                Name = "bad-region"
                Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "east/us!"
                    managedScopes = @("/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)")
                }
                Targets = @($script:target)
                Pattern = "location must be an Azure region name"
            },
            @{
                Name = "user-assigned-without-id"
                Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @("/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)")
                    identity = @{ type = "UserAssigned" }
                }
                Targets = @($script:target)
                Pattern = "requires exactly one userAssignedIdentityResourceId"
            },
            @{
                Name = "unsupported-request-field"
                Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @("/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)")
                    tags = @{ owner = "orders" }
                }
                Targets = @($script:target)
                Pattern = "unsupported fields"
            },
            @{
                Name = "target-in-other-subscription"
                Request = @{
                    subscriptionId = $script:subscription
                    resourceGroup = $script:resourceGroup
                    location = "eastus"
                    managedScopes = @("/subscriptions/$($script:subscription)")
                }
                Targets = @("/subscriptions/$($script:otherSubscription)/resourceGroups/$($script:resourceGroup)/providers/Microsoft.Web/sites/orders")
                Pattern = "outside the requested subscription"
            }
        )

        foreach ($case in $cases) {
            $result = Start-PreflightRun -Name $case.Name -Request $case.Request -Targets $case.Targets
            $result.ExitCode | Should -Be 2 -Because "$($case.Name): $($result.Text)"
            $result.Text | Should -Match $case.Pattern -Because $case.Name
        }
    }

    It "requires the pinned user-assigned identity before reusing a workspace" {
        $identityId = "/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)/providers/Microsoft.ManagedIdentity/userAssignedIdentities/chaos-uai"
        $request = @{
            subscriptionId = $script:subscription
            resourceGroup = $script:resourceGroup
            location = "eastus"
            managedScopes = @("/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)")
            identity = @{ type = "UserAssigned"; userAssignedIdentityResourceId = $identityId }
        }
        $start = Start-PreflightRun -Name "uai" -Request $request
        $start.ExitCode | Should -Be 0 -Because $start.Text
        $statePath = $start.Json.result.statePath

        $systemAssigned = New-WorkspaceResource -Name "ws-system"
        $plan = Invoke-Plan -Name "uai-mismatch" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($systemAssigned))
        $plan.Json.result.plan.decision | Should -Be "create"
        ($plan.Json.result.plan.discoveryEvidence.rejected[0].reason) | Should -Match "identity type"
        $plan.Json.result.plan.createRequest.identity.userAssignedIdentityResourceId | Should -Be $identityId

        $matching = New-WorkspaceResource -Name "ws-uai" -Identity @{
            type = "UserAssigned"
            userAssignedIdentities = @{ $identityId = @{ principalId = "p" } }
        }
        $plan2 = Invoke-Plan -Name "uai-match" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($systemAssigned, $matching))
        $plan2.Json.result.plan.decision | Should -Be "reuse"
        $plan2.Json.result.plan.selected.name | Should -Be "ws-uai"
    }

    It "fails closed and escalates when the created workspace does not match the request" {
        $start = Start-PreflightRun -Name "mismatch"
        $statePath = $start.Json.result.statePath
        $plan = Invoke-Plan -Name "mismatch" -StatePath $statePath -Discovery (New-Discovery)
        $plan.Json.result.plan.decision | Should -Be "create"

        $wrong = New-WorkspaceResource -Name "someone-elses-workspace"
        $final = Invoke-Finalize -Name "mismatch" -StatePath $statePath -PlanPath $plan.PlanPath -Result @{
            ok = $true
            result = @{
                workspace = $wrong
                roleAssignments = @(
                    @{
                        scope = "/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)"
                        status = "granted"
                    }
                )
            }
        }
        $final.ExitCode | Should -Be 0 -Because $final.Text
        $final.Json.result.workspaceStatus | Should -Be "failed"

        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $state.workspace.status | Should -Be "failed"
        $state.workspace.selected | Should -BeNullOrEmpty
        $state.workspace.remediationBrief.stage | Should -Be "create"
        $state.workspace.remediationBrief.reason | Should -Match "created workspace name"
        $state.workspace.remediationBrief.requiredCorrections.Count | Should -BeGreaterThan 0
        $state.phase | Should -Be "terminated"
        $state.verdict | Should -Be "escalated"
        $state.terminationReason | Should -Be "escalated"
        (Get-Content $statePath -Raw) | Test-Json -SchemaFile $script:stateSchema | Should -BeTrue
    }

    It "fails closed when the workspace readback is not provisioned Succeeded" {
        $start = Start-PreflightRun -Name "provisioning"
        $statePath = $start.Json.result.statePath
        $existing = New-WorkspaceResource -Name "orders-resilience"
        $plan = Invoke-Plan -Name "provisioning" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($existing))

        $degraded = New-WorkspaceResource -Name "orders-resilience" -ProvisioningState "Failed"
        $final = Invoke-Finalize -Name "provisioning" -StatePath $statePath -PlanPath $plan.PlanPath `
            -Result @{ ok = $true; result = $degraded }

        $final.ExitCode | Should -Be 0 -Because $final.Text
        $final.Json.result.workspaceStatus | Should -Be "failed"
        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $state.workspace.remediationBrief.reason | Should -Match "provisioningState is 'Failed'"
        $state.verdict | Should -Be "escalated"
    }

    It "fails closed when a role assignment for the workspace identity did not succeed" {
        $start = Start-PreflightRun -Name "rbac"
        $statePath = $start.Json.result.statePath
        $plan = Invoke-Plan -Name "rbac" -StatePath $statePath -Discovery (New-Discovery)
        $created = New-WorkspaceResource -Name $plan.Json.result.plan.createRequest.workspaceName

        $final = Invoke-Finalize -Name "rbac" -StatePath $statePath -PlanPath $plan.PlanPath -Result @{
            ok = $true
            result = @{
                workspace = $created
                roleAssignments = @(
                    @{
                        scope = "/subscriptions/$($script:subscription)/resourceGroups/$($script:resourceGroup)"
                        status = "failed"
                        error = "AuthorizationFailed"
                    }
                )
            }
        }

        $final.Json.result.workspaceStatus | Should -Be "failed"
        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $state.workspace.remediationBrief.reason | Should -Match "role assignment did not succeed"
        $state.verdict | Should -Be "escalated"
    }

    It "fails closed when create returns no role assignment for a managed scope" {
        $start = Start-PreflightRun -Name "missing-rbac"
        $statePath = $start.Json.result.statePath
        $plan = Invoke-Plan -Name "missing-rbac" -StatePath $statePath -Discovery (New-Discovery)
        $created = New-WorkspaceResource -Name $plan.Json.result.plan.createRequest.workspaceName

        $final = Invoke-Finalize -Name "missing-rbac" -StatePath $statePath `
            -PlanPath $plan.PlanPath -Result @{
                ok = $true
                result = @{ workspace = $created; roleAssignments = @() }
            }

        $final.Json.result.workspaceStatus | Should -Be "failed"
        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $state.workspace.remediationBrief.reason | Should -Match "do not cover exactly"
        $state.verdict | Should -Be "escalated"
    }

    It "preserves a migrated interaction transition when workspace preflight completes" {
        $start = Start-PreflightRun -Name "migrated-interaction"
        $statePath = $start.Json.result.statePath
        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $normalizedRequest = $state.workspace.request
        $request = @{
            subscriptionId = $normalizedRequest.subscriptionId
            resourceGroup = $normalizedRequest.resourceGroup
            location = $normalizedRequest.location
            managedScopes = $normalizedRequest.managedScopes
            identity = $normalizedRequest.identity
        }
        if ($normalizedRequest.preferredName) {
            $request.preferredName = $normalizedRequest.preferredName
        }
        $state.Remove("workspace")
        $state.policyVersion = "chaos-loop-policy/v1"
        $state.phase = "advisory-approval"
        $state.transition = @{
            status = "blocked"
            from = "advisory"
            to = "advisory-approval"
            reason = "ranked advisory set awaits approval"
        }
        Write-Utf8Json -Path $statePath -Value $state

        $migrated = Invoke-StateTool -Arguments @(
            "migrate",
            "--state", $statePath,
            "--expected-revision", "0",
            "--workspace-request", ($request | ConvertTo-Json -Depth 20 -Compress)
        )
        $migrated.ExitCode | Should -Be 0 -Because $migrated.Text

        $existing = New-WorkspaceResource -Name "orders-resilience"
        $plan = Invoke-Plan -Name "migrated-interaction" -StatePath $statePath `
            -Revision 1 -Discovery (New-Discovery -Workspaces @($existing))
        $final = Invoke-Finalize -Name "migrated-interaction" -StatePath $statePath `
            -Revision 1 -PlanPath $plan.PlanPath -Result @{ ok = $true; result = $existing }

        $final.ExitCode | Should -Be 0 -Because $final.Text
        $ready = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $ready.workspace.status | Should -Be "ready"
        $ready.phase | Should -Be "advisory-approval"
        $ready.transition.status | Should -Be "blocked"
        $ready.transition.to | Should -Be "advisory-approval"
    }

    It "persists a discovery permission failure and escalates" {
        $start = Start-PreflightRun -Name "permissions"
        $statePath = $start.Json.result.statePath
        $failurePath = Join-Path $TestDrive "permissions-error.json"
        Write-Utf8Json -Path $failurePath -Value @{
            ok = $false
            errorType = "AzureError"
            error = "ARM 403 GET .../workspaces: AuthorizationFailed"
        }

        $result = Invoke-StateTool -Arguments @(
            "workspace-fail",
            "--state", $statePath,
            "--expected-revision", "0",
            "--stage", "list",
            "--result", $failurePath,
            "--observed-at", "2026-08-14T10:00:00Z"
        )

        $result.ExitCode | Should -Be 0 -Because $result.Text
        $result.Json.result.workspaceStatus | Should -Be "failed"
        $state = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $state.workspace.remediationBrief.stage | Should -Be "list"
        $state.workspace.remediationBrief.reason | Should -Match "AuthorizationFailed"
        ($state.workspace.remediationBrief.requiredCorrections -join " ") | Should -Match "Reader"
        $state.phase | Should -Be "terminated"
        $state.verdict | Should -Be "escalated"
        (Get-Content $statePath -Raw) | Test-Json -SchemaFile $script:stateSchema | Should -BeTrue
    }

    It "rejects a workspace failure record for a successful tool result" {
        $start = Start-PreflightRun -Name "not-a-failure"
        $statePath = $start.Json.result.statePath
        $resultPath = Join-Path $TestDrive "not-a-failure.json"
        Write-Utf8Json -Path $resultPath -Value @{ ok = $true; result = @{ workspaces = @() } }

        $result = Invoke-StateTool -Arguments @(
            "workspace-fail",
            "--state", $statePath,
            "--expected-revision", "0",
            "--stage", "create",
            "--result", $resultPath
        )

        $result.ExitCode | Should -Be 2
        $result.Text | Should -Match "requires a failed tool result"
        (Get-Content $statePath -Raw | ConvertFrom-Json).workspace.status | Should -Be "pending"
    }

    It "rejects a plan produced for a different request, run, or revision" {
        $start = Start-PreflightRun -Name "plan-binding"
        $statePath = $start.Json.result.statePath
        $existing = New-WorkspaceResource -Name "orders-resilience"
        $plan = Invoke-Plan -Name "plan-binding" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($existing))
        $document = Get-Content $plan.PlanPath -Raw | ConvertFrom-Json -AsHashtable

        $tampered = $document.Clone()
        $tampered.requestHash = ("0" * 64)
        $tamperedPath = Join-Path $TestDrive "tampered-plan.json"
        Write-Utf8Json -Path $tamperedPath -Value $tampered
        $badHash = Invoke-Finalize -Name "plan-binding-hash" -StatePath $statePath `
            -PlanPath $tamperedPath -Result @{ ok = $true; result = $existing }
        $badHash.ExitCode | Should -Be 2
        $badHash.Text | Should -Match "different workspace request"

        $otherRun = $document.Clone()
        $otherRun.runId = [guid]::NewGuid().ToString()
        $otherRunPath = Join-Path $TestDrive "other-run-plan.json"
        Write-Utf8Json -Path $otherRunPath -Value $otherRun
        $badRun = Invoke-Finalize -Name "plan-binding-run" -StatePath $statePath `
            -PlanPath $otherRunPath -Result @{ ok = $true; result = $existing }
        $badRun.ExitCode | Should -Be 2
        $badRun.Text | Should -Match "runId mismatch"

        $staleRevision = $document.Clone()
        $staleRevision.expectedStateRevision = 7
        $stalePath = Join-Path $TestDrive "stale-plan.json"
        Write-Utf8Json -Path $stalePath -Value $staleRevision
        $badRevision = Invoke-Finalize -Name "plan-binding-revision" -StatePath $statePath `
            -PlanPath $stalePath -Result @{ ok = $true; result = $existing }
        $badRevision.ExitCode | Should -Be 2
        $badRevision.Text | Should -Match "expectedStateRevision mismatch"

        (Get-Content $statePath -Raw | ConvertFrom-Json).workspace.status | Should -Be "pending"
        (Get-Content $statePath -Raw | ConvertFrom-Json).stateRevision | Should -Be 0
    }

    It "keeps the selected workspace immutable and never rediscovers in later phases" {
        $start = Start-PreflightRun -Name "immutable"
        $statePath = $start.Json.result.statePath
        $existing = New-WorkspaceResource -Name "orders-resilience"
        $plan = Invoke-Plan -Name "immutable" -StatePath $statePath `
            -Discovery (New-Discovery -Workspaces @($existing))
        $final = Invoke-Finalize -Name "immutable" -StatePath $statePath -PlanPath $plan.PlanPath `
            -Result @{ ok = $true; result = $existing }
        $final.ExitCode | Should -Be 0 -Because $final.Text

        $ready = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        $selectedJson = $ready.workspace | ConvertTo-Json -Depth 100

        # Re-planning after the workspace is ready is refused: no rediscovery.
        $replan = Invoke-Plan -Name "immutable-replan" -StatePath $statePath -Revision 1 `
            -Discovery (New-Discovery -Workspaces @((New-WorkspaceResource -Name "ws-newer")))
        $replan.ExitCode | Should -Be 2
        $replan.Text | Should -Match "already complete"

        # A second finalize is refused as well.
        $refinalize = Invoke-Finalize -Name "immutable-refinalize" -StatePath $statePath `
            -PlanPath $plan.PlanPath -Revision 1 -Result @{ ok = $true; result = $existing }
        $refinalize.ExitCode | Should -Be 2
        $refinalize.Text | Should -Match "already complete"

        # A phase may not write the workspace through its handoff.
        $decision = @{
            disposition = "repair"
            repairBrief = @{
                reason = "Scenario configuration is missing"
                requiredCorrections = @("Create a validated configuration")
            }
        }
        $unowned = Join-Path $TestDrive "immutable-unowned.json"
        Write-Utf8Json -Path $unowned -Value @{
            evaluation = @{ engine = "chaos_loop_state.py"; policyVersion = "chaos-loop-policy/v2" }
            contractVersion = "chaos-loop-contract/v1"
            runId = $ready.runId
            expectedStateRevision = 1
            phase = "resilience-analysis"
            result = @{ mode = "initial"; analysisHandoff = $decision }
            handoff = @{
                analysisDecision = $decision
                unresolvedCaveats = @()
                workspace = @{ status = "ready" }
            }
            transition = @{
                status = "ready"
                from = "resilience-analysis"
                to = "resilience-analysis"
                reason = "repair"
            }
        }
        $rejected = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "1",
            "--phase", "resilience-analysis",
            "--output", $unowned
        )
        $rejected.ExitCode | Should -Be 2
        $rejected.Text | Should -Match "unowned handoff fields"

        # A legitimate phase application preserves the selected workspace byte-for-byte.
        $allowed = Join-Path $TestDrive "immutable-allowed.json"
        Write-Utf8Json -Path $allowed -Value @{
            evaluation = @{ engine = "chaos_loop_state.py"; policyVersion = "chaos-loop-policy/v2" }
            contractVersion = "chaos-loop-contract/v1"
            runId = $ready.runId
            expectedStateRevision = 1
            phase = "resilience-analysis"
            result = @{ mode = "initial"; analysisHandoff = $decision }
            handoff = @{ analysisDecision = $decision; unresolvedCaveats = @() }
            transition = @{
                status = "ready"
                from = "resilience-analysis"
                to = "resilience-analysis"
                reason = "repair"
            }
        }
        $applied = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "1",
            "--phase", "resilience-analysis",
            "--output", $allowed
        )
        $applied.ExitCode | Should -Be 0 -Because $applied.Text
        $after = Get-Content $statePath -Raw | ConvertFrom-Json -AsHashtable
        ($after.workspace | ConvertTo-Json -Depth 100) | Should -Be $selectedJson
        $after.stateRevision | Should -Be 2
    }

    It "blocks evaluate and apply until the workspace is ready" {
        $start = Start-PreflightRun -Name "gate"
        $statePath = $start.Json.result.statePath
        $proposal = Join-Path $TestDrive "gate-proposal.json"
        Write-Utf8Json -Path $proposal -Value @{
            contractVersion = "chaos-loop-contract/v1"
            runId = $start.Json.result.state.runId
            expectedStateRevision = 0
            phase = "resilience-analysis"
            result = @{ mode = "initial"; hypotheses = @() }
        }

        $evaluate = Invoke-StateTool -Arguments @(
            "evaluate",
            "--state", $statePath,
            "--expected-revision", "0",
            "--phase", "resilience-analysis",
            "--input", $proposal,
            "--output", (Join-Path $TestDrive "gate-output.json")
        )
        $evaluate.ExitCode | Should -Be 2
        $evaluate.Text | Should -Match "Workspace preflight is incomplete"

        $decision = @{
            disposition = "repair"
            repairBrief = @{ reason = "no workspace"; requiredCorrections = @("run preflight") }
        }
        $output = Join-Path $TestDrive "gate-phase-output.json"
        Write-Utf8Json -Path $output -Value @{
            evaluation = @{ engine = "chaos_loop_state.py"; policyVersion = "chaos-loop-policy/v2" }
            contractVersion = "chaos-loop-contract/v1"
            runId = $start.Json.result.state.runId
            expectedStateRevision = 0
            phase = "resilience-analysis"
            result = @{ mode = "initial"; analysisHandoff = $decision }
            handoff = @{ analysisDecision = $decision; unresolvedCaveats = @() }
            transition = @{
                status = "ready"
                from = "resilience-analysis"
                to = "resilience-analysis"
                reason = "repair"
            }
        }
        $apply = Invoke-StateTool -Arguments @(
            "apply",
            "--state", $statePath,
            "--expected-revision", "0",
            "--phase", "resilience-analysis",
            "--output", $output
        )
        $apply.ExitCode | Should -Be 2
        $apply.Text | Should -Match "Workspace preflight is incomplete"
        (Get-Content $statePath -Raw | ConvertFrom-Json).stateRevision | Should -Be 0
    }

    It "records a discovery tool failure instead of planning from it" {
        $start = Start-PreflightRun -Name "discovery-error"
        $statePath = $start.Json.result.statePath
        $plan = Invoke-Plan -Name "discovery-error" -StatePath $statePath -Discovery @{
            ok = $false
            errorType = "AzureError"
            error = "ARM 403 AuthorizationFailed"
        }

        $plan.ExitCode | Should -Be 2
        $plan.Text | Should -Match "workspace-fail"
        (Get-Content $statePath -Raw | ConvertFrom-Json).workspace.status | Should -Be "pending"
    }
}
