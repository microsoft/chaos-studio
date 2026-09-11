---
name: chaos-study-run
description: "Execute a frozen Chaos study plan against Azure using Chaos Studio V2: verify plan integrity, create and validate a scenario configuration, require an explicit typed consent phrase, collect baseline evidence, execute the scenario run, collect during and post-recovery evidence, and always clean up the configuration. Dry-run by default."
---

# chaos-study-run — the only phase that changes production

Everything before this is analysis. This skill executes a real Chaos Studio
scenario against real Azure resources, so it is deliberately the most
conservative script in the suite.

## Principles

**Dry run is the default.** `-DryRun` defaults to `$true`. A dry run walks the
entire sequence — plan verification, the configuration it would create, the
consent phrase — and executes nothing. Read it before arming anything.

**Consent is typed, not flagged.** Arming requires `-DryRun:$false` **and**
`-Consent` matching the phrase the plan prints, exactly. A wrong phrase exits
`11`. There is no `-Yes`, no `-Force` that bypasses it, and no environment
variable that pre-approves it.

**Granting access is a second, separate consent.** Injecting a fault is
reversible and bounded; a role assignment is neither. So `-ApprovePermissions`
takes its own phrase, derived from the grants the service actually previewed,
and one consent can never stand in for the other.

**The plan is verified, not trusted.** The plan hash is recomputed before
execution. Any drift since scoping exits `12`. If the blast radius changed after
you approved it, this refuses rather than running something you did not review.

**Validation is a gate, not advice.** The scenario configuration is created and
validated *before* any evidence is collected or anything is injected, and the run
is refused unless the service reports `Succeeded`. If validation fails, the
missing role assignments are previewed with `--what-if` and shown — and then the
study stops. Granting them is not covered by the injection consent: a role
assignment outlives the study and changes who can reach those resources
afterwards, whereas the injection ends when the run ends. So it takes its own
phrase, bound to the exact grant set the service previewed. Neither consent
implies the other, and a preview that widens invalidates the phrase.

**Evidence is collected around the run, not just during it.** Baseline, during,
and post windows are all collected. Without baseline there is no "normal" to
compare to; without post there is no way to tell degradation from damage.

**Missing evidence stays missing.** A collector that fails records `null` and a
reason. Nothing is interpolated, averaged, or inferred to fill a gap — the report
would rather say *not measured* than mislead.

**Cleanup is unconditional, and removal is observed rather than assumed.** The
scenario configuration is deleted in a `finally` block, so a crash, a Ctrl-C, or
a failed collection still tears it down. A run still in flight is cancelled. The
delete returning 0 only means the control plane accepted the request, so each
removal is followed by a read-back: only an observed absence is reported as
removed, and anything still present stays in the residue ledger with the exact
command to finish the job. Use `-KeepConfiguration` only when you intend to
inspect it afterwards.

**Sealed studies are immutable.** Re-running a sealed study exits `13`. Re-test
by scoping a new one, so history stays comparable.

## Usage

**Preview** (this is the default, and executes nothing):

```powershell
./scripts/Invoke-ChaosStudyRun.ps1 -StudyId latest
```

**Arm it**, using the phrase the preview printed:

```powershell
./scripts/Invoke-ChaosStudyRun.ps1 -StudyId latest -DryRun:$false `
    -Consent '<phrase from the preview>'
```

Switches worth knowing:

- `-SignalSource` — add evidence sources beyond the plan's (`metrics:` / `logs:`)
- `-PollSeconds` — scenario run status poll interval
- `-KeepConfiguration` — leave the configuration for inspection

## What actually happens

1. Load the plan and re-verify its hash
2. Render the consent phrase and require it back verbatim
3. Create the scenario configuration on the workspace, carrying the plan's
   frozen parameters, filters and exclusions
4. Validate it; on failure, preview the missing grants with `--what-if` and stop
   with exit 19 unless `-ApprovePermissions '<phrase>'` matches that preview —
   only then apply the grants, record them, and validate again
5. Refuse to continue unless validation now says `Succeeded`
6. Collect the **baseline** window
7. Execute the configuration; poll the scenario run until it reaches a terminal
   state or the injection window closes
8. Collect the **during** window while the run is live
9. Wait out recovery, then collect the **post** window
10. Cancel any in-flight run and delete the configuration (always), then write
    `run-record.v3.json` and evidence

Steps 3–5 run before step 6 deliberately. A configuration that cannot validate
is a run that fails within seconds, and finding that out after a baseline window
has already elapsed wastes the window and the study. `Start-ChaosStudyScenarioRun`
takes the validation result as a required argument and asserts it again as the
last thing before `run start`, so the guarantee belongs to the function that
starts the run rather than to the order of statements in one caller.

The configuration is built from what the plan captured live at scope time: the
scenario, its parameters as the `{key,value}` pairs the service takes, and the
blast radius as `filters` and `exclusions`. An empty blast-radius member is
omitted rather than sent — `{"locations":[]}` means *no locations*, which would
silently turn a real study into a no-op that still reports success.

## Implementation note

Execution uses Chaos Studio **V2** exclusively: workspaces are the lifecycle
root, resource selection comes from workspace scopes and the resources the
service discovered inside them, and the run is a scenario run against a
validated scenario configuration. There is no V1 path and no fallback to one.
Api-versions are pinned centrally so a service-side default change cannot
silently alter behaviour.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (including a completed dry run) |
| `1` | Error |
| `11` | Consent declined or phrase mismatch |
| `12` | Plan changed after it was frozen |
| `13` | Study already sealed |
| `17` | Scenario configuration failed validation |
| `19` | Role assignments needed; re-run with `-ApprovePermissions` |
| `18` | Paused: an Azure operation must be executed by the host, then resumed |
| `22` | No adapter can reach Azure — pass `-Adapter` explicitly |
| `23` | Study was written by an older contract version |

`18` is a pause, not a failure, and it is the one exit where the temptation to
improvise is most dangerous. Under `-Adapter external` this phase cannot call
Azure itself, so it wrote the exact request — including the scenario run start or
status poll — into the study's `operations/` directory. Execute that call with
your own authenticated tooling, write the response back as the matching result
file, and re-run the identical command. The run resumes from where it stopped;
consent and the frozen plan hash still hold, so nothing is re-armed and no fault
is injected twice.

Do not fabricate a run outcome or hand-write evidence to get past this. Results
are hashed against their request and recorded in the study's provenance, and a
report built on unprovenanced evidence cannot be sealed as compliant.

## If it fails partway

The study state on disk reflects exactly how far it got, and whatever evidence
was collected is kept. Because reporting is a pure read of that evidence, a
partial run can still be reported — the report will simply carry the gaps as
explicit limitations rather than hiding them.

## Next

```powershell
chaos-study-report -StudyId <studyId>
```

See `../chaos-study/references/study-method.md` for how the windows are chosen.
Per-action blast radius is not documented locally: it comes from the live action
metadata frozen into the plan, which the dry run prints in full.
