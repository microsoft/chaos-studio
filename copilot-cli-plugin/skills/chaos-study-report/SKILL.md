---
name: chaos-study-report
description: "Interpret the evidence from an executed Chaos study and render a self-contained HTML report: steady-state verdict, tests run, evidence tables, prioritized findings with severity, explicit limitations, and remediation guidance. Pure read of collected evidence — executes nothing."
---

# chaos-study-report — turn evidence into a defensible conclusion

The run produced numbers. This skill decides what they mean, and — just as
importantly — what they do **not** mean.

## Principles

**Interpretation is pure.** This skill reads only what the run wrote. It calls no
Azure APIs, collects nothing new, and changes nothing in your environment. Given
the same evidence it produces the same report, every time.

**Absent evidence is reported as absent.** A signal that was not collected
renders as *not measured*, never as `0`. A zero is a measurement; a gap is not.

**A pass requires proof the action landed.** Movement is not proof. The plan
freezes a mechanism probe with a numeric condition, and the report evaluates that
exact condition against evidence taken from inside the action's own window. A
signal that drifted the right way but never met the threshold does not prove
anything, and a condition that cannot be parsed or was never measured is reported
as unproven with its reason — never as a pass. Without that proof the verdict is
**Inconclusive**, not "held". Claiming resilience against an action that never
arrived is the most expensive mistake this suite can make, so it is designed out.

**Severity follows recovery, not drama.** A breach that never recovers is
`critical`. The identical breach that self-heals within the recovery window is
`medium`. What matters is whether the system came back.

**Limitations are part of the finding, not a footnote.** Every report states what
it could not establish. A short injection window, a missing signal, an unproven
mechanism — each gets an explicit code so a reader can judge how much weight the
conclusion carries.

**The report must survive being emailed.** One file, no network. All CSS is
inline, there is no JavaScript, and no external images or fonts are referenced.
The renderer refuses to emit a report containing a `<script>` tag or an
unsubstituted token.

## Usage

```powershell
./scripts/Invoke-ChaosStudyReport.ps1 -StudyId latest
```

Options:

- `-NoSeal` — render for review without sealing the study
- `-OutputPath` — write the HTML somewhere else as well

Writes `findings.v2.json` and `report.html` into the study directory, then seals
the study. Sealed studies are never overwritten: re-reporting a sealed study
renders beside it as `report-<studyId>.html` and exits `0`.

## Verdicts

| Verdict | Condition |
| --- | --- |
| **Steady state breached** | any `critical` finding — breached and did not recover |
| **Degraded but recovered** | breached during injection, recovered in the post window |
| **Inconclusive** | the action could not be proven to have landed |
| **Steady state held** | the action landed and the objective survived |

## Report sections

1. Masthead — verdict, workspace, scope, action, window
2. What was asked — the steady-state predicate and hypothesis
3. Tests run — the action as the service described it, windows, scenario run outcome
4. Evidence — signal-by-signal, before / during / after
5. Findings — prioritized, with severity and the evidence behind each
6. Limitations — what this study could not establish
7. Remediation — what to do about the findings
8. Provenance — plan hash, command trail, api-versions

The "Tests run" section states that the action metadata was discovered live from
`Microsoft.Chaos/locations/{region}/actions`, so a reader can see the identity,
type and applicability came from the platform rather than from a local list.

## Limitation codes

| Code | Meaning |
| --- | --- |
| `L1` | A single study is a sample, not a proof of general resilience |
| `L2` | One or more planned signals were not collected |
| `L3` | The action mechanism could not be proven to have landed |
| `L7` | Injection window ≤ 3 minutes — too short to separate resilience from luck |
| `L8` | The scenario run failed or was cancelled mid-run |
| `L9` | The plan hash did not match at run time |
| `L10` | Action metadata was not confirmed against the live action list |

Additional codes are carried forward from the readiness gates recorded at scope
time. `L1` is always present — by design, because it is always true.

## Notes

- The report is deterministic apart from its `generatedAt` timestamp.
- Every value is HTML-escaped on the way in; evidence is untrusted input.
- Findings carry a stable `findingKey` so `chaos-study-history` can tell a
  persisting problem from a new one across studies.
- **Never write this report by hand.** The renderer is the only thing that can
  produce one, because the report's authority comes entirely from what it reads:
  the frozen plan, the run record, the evidence, the operation provenance and the
  manifest hashes. A hand-written HTML file with the same headings is a claim
  without a chain of custody — it cannot be sealed, it cannot be compared by
  `chaos-study-history`, and its verdict means nothing. If the study is missing
  the artifacts this phase needs, the honest move is to finish or resume the
  study, not to compose the conclusion yourself.
- Appendix content is likewise generated, not narrated: adapter provenance,
  effective legs, permission grants, residue and command trail all come from the
  store. If something is unknown it renders as unknown, never as an assumption.

See `../chaos-study/references/report-contract.md` for the full contract the
renderer enforces.

## Next

```powershell
chaos-study-history -Action compare
```
