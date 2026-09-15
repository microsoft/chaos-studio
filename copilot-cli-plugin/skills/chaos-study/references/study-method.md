# The study method

This is the reasoning the `chaos-study` suite follows. Read it once; it
explains *why* each skill refuses certain things.

## A study is an experiment, not a test run

A test asserts a known answer. A study asks a question whose answer you do not
know, and produces evidence either way. That difference drives everything here:

- We state a **hypothesis** before anything runs, so we cannot rationalise the
  result afterwards.
- We measure a **steady state** first. Without it, "it looked fine" is an
  opinion.
- We record **what we could not measure** as prominently as what we could.
  A study that hides its blind spots is worse than no study, because it
  manufactures confidence.

## The V2 model this suite is built on

Chaos Studio V2 makes the **workspace** the lifecycle root. A workspace observes
one or more **scopes**, and the service discovers the resources inside them. You
do not enumerate resources by hand and you do not onboard them one at a time:
you point a workspace at a scope and read back what it found.

Everything downstream hangs off that. Scenarios are recommended per workspace, a
**scenario configuration** binds a scenario to a workspace with parameters and a
blast radius, validation runs against that configuration, and execution produces
a **scenario run**. This suite uses that model exclusively — there is no V1 path
and no fallback to one.

## The six phases

### 1. Design

Decide *what is worth testing at all*, before any Azure call is made.

This phase exists because the most common way a reliability study fails is not a
bad injection — it is a well-executed injection of something that never mattered.
An action is picked because it is available, it runs, nothing moves, and the
system is declared resilient. Nothing was learned, but a report now says
otherwise.

Design fixes the ordering. First the system is *read*: code, deployment, the
dependency graph, retry and fallback behaviour, persistence paths, workload
shape, existing telemetry, and deployment identity. Each of those eight areas is
either observed with a citation or explicitly declared unavailable with a reason.
Silence fails at exit code 24. A hypothesis may not rest on evidence nobody read.

Only then is the customer interviewed — one question at a time, in dependency
order, and vague answers are refused rather than recorded. Questions that
analysis already answered are pre-filled and skipped, so the customer is asked
only for what only they can supply: what they want to learn, the business impact
they care about, the change they are validating, the blast radius and data-loss
risk they accept, production or not, their abort threshold, the window, how
representative the traffic is, and whether discrete or destructive actions are
acceptable at all.

The output is a ranked set of two to four **candidate hypotheses**, each carrying
a dependency edge, a concrete failure mechanism, the code evidence for it, an
exact data-plane probe, a falsifiable predicate, exposure inputs, collateral
risks, a suggested blast radius and abort criteria. Candidates are intersected
with live regional action discovery and the workspace's own recommended
scenarios; when Azure cannot be reached they are marked *provisional* and
limitation `L15` is recorded rather than guessing what the platform offers.

Nothing is recommended as final until the customer returns the exact confirmation
phrase, which is bound to the brief hash so it keeps referring to what they
actually saw. The confirmed brief then feeds scoping, so no decision is retyped
and none is silently changed in transit.

### 2. Scope

Turn the confirmed intent into a frozen, checkable plan — before anything runs.

The action is not chosen from a list this suite carries. It is chosen from the
list Chaos Studio returns for the workspace's region, live, at scope time. That
response is authoritative for the action's identity, its type, what it applies
to and its parameter schema. There is no bundled catalogue and no offline
fallback: if the platform cannot be asked, scoping stops at exit code 16.

What is *in* scope is read the same way. The resources a run can touch are the
ones the workspace discovered, filtered by the blast radius the plan freezes.
Reading them rather than asserting them is the point: a scope that quietly grew
a resource, or a plan naming a resource that was never discovered, are exactly
the surprises this catches.

The output is a **study plan**: workspace, scope and its discovered resources,
action and scenario metadata as discovered, steady-state predicate, abort
conditions, and the signals that will be collected. A plan is a written
commitment. If the plan cannot be written, the study does not happen.

Scoping fails closed. If nothing is in scope, or the action applies to no
resource type present, we stop at exit code 14 rather than substituting a
different action that answers a different question.

### 3. Readiness

Verify the plan is executable *and* observable.

Two independent checks:

- **Executable** — is there anything in scope for this action to act on, does
  what the action applies to intersect the discovered resource types, and do the
  supplied parameters satisfy the schema the service published?
- **Observable** — will we be able to tell what happened? If no signal source
  covers the impact, the study can still run, but it will produce a finding
  with `confidence: low` and a mandatory limitation. We say so *before*
  running, not after.

Readiness failure is exit code 10. It is not a warning.

### 4. Execute

Run the scenario inside a bounded window, with the abort path armed.

Rules that do not bend:

- **Validation is a gate.** The scenario configuration is created and validated,
  and execution is refused unless the service reports `Succeeded` (exit 17). A
  configuration that only probably works is not executed.
- **Dry run is the default.** Execution requires an explicit `-DryRun:$false`
  *and* a typed consent string bound to the frozen config hash. If the plan
  changed after consent was given, the consent is void (exit 12).
- **Non-interactive escape hatches do not apply.** The study suite ignores
  `STARTCHAOS_NONINTERACTIVE`. A human types the consent string or nothing runs.
- **The blast radius is in the plan, not in the operator's head.** The scope
  filters and exclusions, the parameters and the duration are frozen at consent
  time. An empty blast-radius member is omitted rather than sent as an empty
  array, because `{"locations":[]}` selects nothing and would turn a real study
  into a no-op that still reports success.
- **Abort is not cleanup.** Abort conditions are evaluated during the run; if
  one trips, the run is cancelled and the study records that it was aborted,
  which is itself a finding. Cleanup of the configuration happens regardless.

### 5. Observe

Collect three windows: `pre`, `during`, `post`. All windows are half-open
`[start, end)` so a sample can never be counted twice.

The non-negotiable rule: **a missing measurement is `null`, never `0`.**
Zero means "we measured, and it was zero". Null means "we did not measure",
and it must carry a caveat saying why. Every signal collector returns the same
shape so this cannot be fudged.

Control-plane state — "the scenario run reported Succeeded" — is **not** proof
that the action reached the system under study. It proves Chaos Studio accepted
and executed the request. Only a data-plane signal can set
`mechanismProven: true`.

### 6. Conclude

Turn evidence into findings, then seal.

- **Severity** comes from behaviour, not from how alarming the action sounds:
  - `critical` — steady state breached and *not* recovered in the post window
  - `high` — breached, recovered, but later than the stated objective
  - `medium` — breached, recovered within the objective
  - `low` — steady state held, but a secondary signal degraded
- **Confidence** comes from `mechanismProven` and signal-source coverage.
  A finding drawn only from control-plane state is capped at `low`.
- **Limitations are mandatory and never empty.** At minimum, L1 (scope) always
  applies: this study ran one action over one scope in one window.

Sealing makes the study immutable. The report is rendered, every file is
hashed, the manifest records the hashes and the api-version pins, and then —
and only then — `SEALED` is written. A sealed study is evidence you can cite
six months later.

## Why the suite is six skills

One skill that did all of this would be unreadable and untestable. Splitting on
the phase boundaries gives each skill one job, one output, and one failure
mode:

| Skill | Owns | Produces |
|---|---|---|
| `chaos-study` | the opinionated end-to-end path | an orchestrated study |
| `chaos-study-design` | analysis, interview, candidate hypotheses | `study-brief.v1.json` |
| `chaos-study-scope` | workspace, scope, discovery, readiness | `study-plan.v3.json` |
| `chaos-study-run` | configuration, consent, execution, observation | `run-record.v3.json` |
| `chaos-study-report` | interpretation, rendering, sealing | `findings.v2.json`, `report.html` |
| `chaos-study-history` | recall and comparison | listings, diffs, reruns |

Each is usable alone. `chaos-study` is the front door for anyone who does not
want to think about the seams.

## What this suite deliberately does not do

- **No V1.** No experiments, no targets, no capabilities, and no fallback to
  them when V2 discovery or configuration is unavailable.
- **No SRE Agent dependency.** The core path is `az chaos`.
- **No required MCP dependency.** MCP may enrich, never gate.
- **No auto-remediation.** A study reports; a human decides.
- **No invented evidence.** If a number is not measured, it is not printed.
