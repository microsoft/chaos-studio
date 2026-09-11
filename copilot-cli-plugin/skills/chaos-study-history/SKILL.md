---
name: chaos-study-history
description: "List, inspect, compare, and re-run past Chaos reliability studies from the dated study store. Answers 'did we fix it?' by diffing findings between two comparable studies of the same scope, and prints the exact command to re-run a study as a new one."
---

# chaos-study-history — did the fix actually work?

A single study is a snapshot. Reliability is a trend. This skill reads the dated
study store so a chat weeks later can pick up exactly where the last one left off.

## Principles

**Studies are immutable.** A sealed study is a historical record. Re-testing
creates a **new** study rather than overwriting the old one — otherwise there is
nothing to compare against and no way to show improvement.

**Only compare like with like.** Two studies are comparable only if the scope,
workspace, action, scenario, scoped-resource count and normalised predicate
match, and each window is within ±20% of its counterpart. Anything else exits
`15` and explains which attribute diverged. A comparison across different
actions is not evidence.

**Findings are matched by key, not by title.** Every finding carries a stable
`findingKey`. Rewording a title does not make a problem look resolved, and a
genuinely different problem never masquerades as the same one.

**Direction is stated plainly.** `improved`, `regressed`, `stable`, or `unknown`
— and `unknown` is used honestly whenever the evidence does not support a call.

**Re-run prints, it does not execute.** The `rerun` action emits the exact scope
command that reproduces a study. You review it and run it. Nothing is executed
from here. Because scoping re-queries the live action list, a rerun of a study
whose action the platform no longer offers fails loudly instead of silently
testing something else.

## Usage

**List studies:**

```powershell
./scripts/Invoke-ChaosStudyHistory.ps1 -Action list
```

Add `-ScopeHash <hash>` to narrow to one workspace/scope pairing, or `-Json` for
machine-readable output.

**Inspect one:**

```powershell
./scripts/Invoke-ChaosStudyHistory.ps1 -Action show -StudyId <studyId>
```

**Compare** — by default the latest study against the most recent comparable one
in the same scope:

```powershell
./scripts/Invoke-ChaosStudyHistory.ps1 -Action compare
./scripts/Invoke-ChaosStudyHistory.ps1 -Action compare -StudyId <candidate> -Against <baseline>
```

**Re-run** — prints the command that reproduces a study as a new one:

```powershell
./scripts/Invoke-ChaosStudyHistory.ps1 -Action rerun -StudyId <studyId>
```

**Diagnostics** — fingerprints the installed suite. Works offline, needs no Azure
and no prior study, so it answers "which code am I actually running?" on a fresh
install or when something else is broken:

```powershell
./scripts/Invoke-ChaosStudyHistory.ps1 -Action diagnostics
./scripts/Invoke-ChaosStudyHistory.ps1 -Action diagnostics -Json   # per-file hashes
```

Quote the content hash in any bug report. Two installs behave identically only if
that hash matches; `-Json` adds the per-file hashes so two installs can be diffed
down to the file that actually differs. Every report carries the same revision in
its appendix, so a report and a bug report can be tied to one revision.

## Reading a comparison

| Field | Means |
| --- | --- |
| **Resolved** | findings present in the baseline, gone in the candidate |
| **Introduced** | findings new in the candidate |
| **Persisted** | present in both — the fix did not land |
| **Verdict changed** | the overall verdict moved between the two studies |
| **Direction** | improved / regressed / stable / unknown |

"Resolved" is the honest answer to *did we fix it?* — provided the two studies
were comparable, which is exactly why comparability is enforced rather than
assumed.

## The study store

Studies live outside the repository so results are never accidentally committed.
The root is resolved in this order:

1. `CHAOS_STUDY_ROOT`
2. `studyRoot` in `.chaos-plugins.yaml`
3. a per-user application-data path

Layout is `<root>/<scopeHash>/<studyId>/`, where `studyId` is
`<UTC timestamp>-<8 hex>`. The scope hash groups every study of the same
subscription / resource group / workspace / scopes / region — the identity of
the system under test, deliberately excluding which action or scenario was
chosen, which is what makes comparison meaningful.

States: `EMPTY`, `PLANNED`, `EXECUTED`, `SEALED`, `ABANDONED`. Only `SEALED`
studies carry a report; the index is rebuilt from disk on every read, so a stale
index can never hide a study.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Error |
| `15` | Studies are not comparable — the reason is printed |
| `23` | A study was written by an older contract version |

## Notes

- Comparison reads only sealed artifacts. It calls no Azure APIs, so it never
  pauses for the host adapter and never needs credentials.
- Findings carry a contract version. Studies written under different versions are
  either compared on the fields they genuinely share, or refused with `15` — they
  are never silently reinterpreted so a diff can be produced.
- Both verdicts travel together: the predicate verdict says whether the steady
  state held, the study verdict can be worse when collateral damage was found.
  Read the pair; a comparison that moved only the study verdict is still news.
- A scope with a single study reports that plainly rather than inventing a
  baseline to diff against.

See `../chaos-study/references/study-method.md` for why studies are stored dated
and immutable.
