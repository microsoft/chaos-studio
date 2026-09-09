# Reviewed source extracts (authoritative contract authority)

These files are **reviewed representative extracts** of the current `Microsoft.Chaos`
`2026-05-01-preview` generated GW/BE source-of-truth artifacts. This is the **public**
`microsoft/chaos-studio` repository, which does **not** contain the internal `Squall`
source, so these extracts are **authored for this integration**: they faithfully encode
the *relevant structure and behavior* of the upstream artifacts (enum members,
serialized fields/channels, domain-logic control flow, the operation set) and carry
brief explanatory commentary — they are **not** byte-for-byte copies of the upstream
files. They are the *single reviewed authority* the contract constants and the wire
fixtures are both authenticated against, closing the "a fixture and a `contract.ts`
constant are two local artifacts that could drift together" gap: there is one reviewed
representation of the source (these extracts), and CI mechanically proves that both
`contract.ts` and every fixture agree with it.

How the authority is established and kept honest:

1. **Out-of-band review (once, by a human reviewer).** Each extract is
   bound in `../provenance.manifest.json#/sources[*]` to a commit-pinned
   permalink (`sourceSnapshot.commitId` + per-source `url`) into the internal
   `Squall` monorepo. A reviewer with monorepo access opens the permalink and
   confirms the committed extract **faithfully represents** the real generated
   artifact at that immutable revision (its enum members, serialized fields/channels,
   control flow, and operation strings — not a byte-for-byte diff, since the extract
   carries commentary). This human review is what makes the extract's *content*
   trustworthy.

2. **In-repo tamper-evidence (every CI run).** The manifest records each extract's
   `extractSha256`. `../../test/contract/provenance.test.ts` recomputes it from
   disk, so an extract cannot change without a reviewable manifest hash change. This
   guards the committed extract in-repo; it is **not** an attestation of upstream
   bytes.

3. **Contract + fixture authentication (every CI run).**
   `provenance.test.ts` *parses these extracts* — the enum member wire values, the
   serialized property/error-channel names, and the generated operation strings —
   and asserts that `contract.ts` and the fixtures encode exactly what the
   extracts contain. The contract's state lists, error channels, and the fixtures'
   operation set are therefore derived-from and checked-against the reviewed
   source, not merely against each other.

Refresh the extracts, the `sourceSnapshot.commitId`, and every permalink together
whenever the generated `2026-05-01-preview` contract advances, then regenerate the
manifest (`node packages/core/fixtures/scripts/generate-provenance.mjs`).

| Extract | Source symbol | Authenticates |
|---|---|---|
| `ScenarioValidationState.g.cs` | `ScenarioValidationState` (generated enum) | `VALIDATION_STATES` (VF3) |
| `ScenarioRunState.g.cs` | `ScenarioRunState` (generated enum) | `RUN_STATES` (VF7) |
| `ValidationProperties.g.cs` | `ValidationProperties` (generated model) | validation wire fields + `errors`/`validationErrors` (VF2, VF10, DX2) |
| `ScenarioRunProperties.g.cs` | `ScenarioRunProperties` (generated model) | run wire fields + `errors`/`executionErrors` (VF6, VF10, DX2) |
| `ScenarioRunResource.g.cs` | `ScenarioRunResource` (generated element model) | the closed element schema (`resourceId`/`targetType`/`selectors`) for the run `resources` object-array, used to recursively validate array items (VF10) |
| `ConfigurationDomainLogicV1.cs` | `ConfigurationDomainLogicV1.ValidateAsync` / `GetLatestValidationAsync` / `ExecuteAsync` (V1 domain logic) | validate returns 202→`validations/latest` with no precondition; validation GET is 202/200; execute returns 202→`runs/{runId}` (VF1, VF2, VF4, VF5, DX3) |
| `RunDomainLogicV1.cs` | `RunDomainLogicV1.GetRunAsync` / `CancelRunAsync` (V1 domain logic) | run GET is 202 nonterminal / 200 terminal; cancel returns 202→the same run resource (VF6, VF8, VF9) |
| `ScenarioConfigurationsController.cs` | `ScenarioConfigurationsController` (BE controller) | validate/execute actions return 202 and dispatch commands; no conditional-request handling and no evaluation gate (VF4, VF11) |
| `StartScenarioValidationCommand.cs` | `StartScenarioValidationCommandHandler` (BE handler) | evaluation not required (null snapshot accepted); validations/latest upserted with no precondition (VF4, VF11) |
| `StartScenarioExecutionCommand.cs` | `StartScenarioExecutionCommandHandler` (BE handler) | evaluation not required; the run id is generated synchronously before persistence (VF5, VF11, DX3) |
| `CancelScenarioRunCommand.cs` | `CancelScenarioRunCommandHandler.Handle` (BE cancel handler) | state-aware cancel: a repeated cancel and a cancel against a terminal run both no-op without throwing (idempotency + terminal no-op, VF8, VF9) |
| `ScenarioRunStateExtensions.cs` | `ScenarioRunStateExtensions.IsTerminal` (BE domain predicate) | the terminal-state predicate the cancel handler's no-op guard calls: it is true for EXACTLY Succeeded/Failed/Canceled and false for Canceling and every advancing state (VF7, VF8) |
| `ScenarioValidationStateExtensions.cs` | `ScenarioValidationStateExtensions.IsTerminal` (BE domain predicate) | the validation terminal-state predicate `GetLatestValidationAsync` calls to branch 200 (terminal) vs 202 (in progress): it is true for EXACTLY Succeeded/RequiresAttention/NoResolvedResources and false for every advancing state, authenticating `VALIDATION_TERMINAL_SUCCESS` + `VALIDATION_TERMINAL_FAILURE` (VF3) |
| `ScenarioValidationStore.cs` | `ScenarioValidationStore.UpsertLatestAsync` (BE store) | validations/latest persisted via an unconditional upsert — no version/precondition parameter (VF4) |
| `ResourceSelectorResolver.cs` | `ResourceSelectorResolver.ResolveAsync` (BE resolver) | the evaluation snapshot parameter is nullable and a null snapshot is accepted; no evaluation prerequisite (VF11) |
| `SelectorEvaluator.cs` | `SelectorEvaluator.ResolveLiveAsync` (BE live evaluator) | the null-snapshot delegate: in the extracted body it resolves via the target query and names no conflict/`409` and no `throw` (VF11) |
| `SelectorTargetQuery.cs` | `SelectorTargetQuery.QueryAsync` (BE concrete terminal callee) | the deepest live-resolution callee: in the extracted body a plain read that names no conflict/`409` and no `throw` (VF11) |
| `ResolutionServiceRegistration.cs` | `ResolutionServiceRegistration.AddResolution` (BE DI registration) | binds each resolution interface to its CONCRETE implementation (resolver→evaluator→target query→store) so the authenticated callees are the ones the runtime resolves (VF11) |
| `SelectorTargetStore.cs` | `SelectorTargetStore.ListTargetsAsync` (BE concrete store) | the deepest state-touching callee: in the extracted body a read-only query (`ToListAsync`) that names no write/optimistic-concurrency op, no conflict/`409`, and no `throw` (VF11) |
| `SelectorMaps.cs` | `ResolvedSelectorMap.From` / `SelectorMap.FromLiveTargets` (BE construction helpers) | the factories the chain calls: in the extracted bodies they name no conflict/`409`, no persistence/concurrency op, and no `throw` (VF11) |
| `ScenarioErrors.g.cs` | `ScenarioError` / `ScenarioValidationError` / `ScenarioExecutionError` (generated models) | the exact nested error wire fields — `code`/`message`, plus `resourceId`/`recommendedRoles` — for the dual error channels (VF10) |
| `WorkspacesExceptionMapper.cs` | `WorkspacesExceptionMapper.Map` (BE exception mapping) | the validate/execute flow maps no PreconditionFailed/412 and no evaluation-required conflict (VF4, VF11) |
| `OperationIntegrationTestsV2026_05_01_preview.GetOperations.verified.txt` | `Operations_List` verified snapshot | the exact provider operation set (VF9, VF12, DX1) |

## Reviewed conclusions drawn from the extracts (not embedded in them)

These conclusions belong in documentation, not embedded in the extracts themselves:

- **VF4 (no plan lock).** Established across the COMPLETE call chain, not a single
  model, and parsed structurally by `provenance.test.ts`: (a) the BE controller
  `ScenarioConfigurationsController.Validate` returns `202` and dispatches the
  command with no conditional-request handling; (b) `ValidationProperties.g.cs`
  serializes the mutable `executionPlanJson` but declares **no** `eTag`, resource
  version, or concurrency/idempotency wire field; (c)
  `ConfigurationDomainLogicV1.ValidateAsync` (GW) returns `202` to
  `validations/latest` with no precondition read and no `412` path; (d)
  `StartScenarioValidationCommand.Handle` (BE) calls the store's upsert; (e)
  `ScenarioValidationStore.UpsertLatestAsync` performs an **unconditional** upsert
  (no version/precondition parameter), overwriting the plan in place; and (f)
  `WorkspacesExceptionMapper.Map` maps **no** `PreconditionFailed`/`412`. Because no
  stage of the code path READS or ENFORCES a precondition and none of the models carry
  an `eTag`/version, the STATICALLY-INFERRED contract is that a caller `If-Match` has
  nothing to be checked against and cannot yield a `412` — so a later validation
  replaces the current execution plan in place. This is a static inference from the
  reviewed source, not an observed end-to-end runtime capture. The authored
  request/response trace in `validate/plan-mutation-sequence.json` ILLUSTRATES that
  inference using a CONCRETE NONMATCHING `If-Match` ETag (the case a precondition-
  honoring service would reject with `412`), so the illustrated `202` is meaningful
  rather than a trivially-satisfiable match-any `*`; the trace is an illustration, not
  the evidence.
- **VF5 / DX3 (run-id from Location).** `ConfigurationDomainLogicV1.ExecuteAsync` and
  `StartScenarioExecutionCommand.cs` show the BE generates the run id synchronously
  and GW returns it as the final segment of the `202` run-resource `Location`.
- **VF6 (validation/run GET).** `ConfigurationDomainLogicV1.GetLatestValidationAsync`
  and `RunDomainLogicV1.GetRunAsync` branch on terminal status to return `200`
  terminal / `202` nonterminal on the same resource.
- **VF8 / VF9 (cancel).** `RunDomainLogicV1.CancelRunAsync` returns `202` to the SAME
  run resource keyed by the run id; there is no validation-cancel or pre-run-id
  cancel.
- **VF10 (dual error channels).** `ScenarioErrors.g.cs` declares the exact nested
  serialization the fixtures' error entries use — `code`/`message` for the system
  `errors` channel, plus `resourceId` and `recommendedRoles` for the validation
  business channel and `resourceId` for the run business channel. The provenance
  tests reject any nested error key the models do not declare. The run `resources`
  object-array is likewise closed: `ScenarioRunResource.g.cs` declares the element
  model (`resourceId`, `targetType`, `selectors`), the properties model binds the
  `resources` channel to it (`IReadOnlyList<ScenarioRunResource>`), and each array
  item is recursively validated against the derived element schema (keys, kinds, and
  scalar/element types) rather than merely checked to be an object.
- **VF11 (evaluation advisory).** The controller has no evaluation short-circuit and
  returns `202` for validate/execute; `ResourceSelectorResolver.ResolveAsync` accepts
  a **nullable** evaluation snapshot (a `null` snapshot resolves against the live
  selectors); both BE handlers pass `null`; and the exception mapper maps no
  evaluation-required conflict. The null path is then authenticated **receiver-bound**
  down the resolution chain actually wired by DI: `ResolveAsync` invokes
  `ResolveLiveAsync` on its injected `ISelectorEvaluator`, which invokes `QueryAsync`
  on its injected `ISelectorTargetQuery`, which invokes `ListTargetsAsync` on its
  injected `ISelectorTargetStore` — each concrete impl pinned by the DI registration.
  Every extracted method on that chain (resolver → live evaluator → target query →
  read-only store → the pure `ResolvedSelectorMap`/`SelectorMap` factories) contains
  no evaluation gate, no conflict throw, no `409`, and no write / optimistic-
  concurrency operation (the store's persistence call is a read-only `ToListAsync`).
  This is a **static inspection of the committed extract BODIES**, not a runtime
  guarantee: the claim is precisely that *the reviewed source text on the inspected
  null-snapshot resolution path names no evaluation gate, no `throw`, no conflict/`409`
  token, and no write/optimistic-concurrency operation*. It is deliberately NOT a
  claim that validate/execute are guaranteed to return `202` and never throw at
  runtime end to end — code the extracts do not include (framework internals, the
  runtime call graph beyond these bodies) is out of scope and unverified here.
