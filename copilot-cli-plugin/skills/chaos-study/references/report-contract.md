# The report contract

`report.html` is the artifact a human actually reads, and often the only one
they read. This file defines what it must contain and what it must never do.

## Hard constraints

- **One file.** Self-contained HTML. Inline CSS, inline SVG. No external
  stylesheet, no CDN, no font fetch, no image file.
- **No `<script>`.** The report is evidence, not an application. It must render
  identically in a browser, an email client preview, and an artifact viewer
  with scripting disabled.
- **Escaped.** Every value drawn from Azure or from the model passes through
  HTML escaping. A resource name containing `<` must not be able to alter the
  document.
- **Deterministic.** Two renders of the same sealed study produce byte-identical
  output except for `generatedAt`. No random ids, no ordering by hash-table
  enumeration, no locale-dependent formatting.
- **Honest about gaps.** A missing measurement renders as `not measured` with
  its caveat — never as `0`, never as a blank cell, never omitted.

## The eight sections, in order

### 1. Header

Study id, workspace, scope, action, window, sealed timestamp, and the overall
verdict. A reader must be able to answer "what was tested and did it hold?"
without scrolling.

### 2. Executive summary

Three to five sentences in plain language. Written for someone who was not in
the room. It states the hypothesis, whether it held, and the single most
important consequence.

No jargon that is not defined later in the document.

### 3. What we tested

The plan, rendered: workspace identity and region, the scoped resources and the
blast radius applied to them, the action as the platform described it —
canonical id, action type, what it applies to — its parameters, the steady-state
predicate, abort conditions, and the three window boundaries.

The report states that the action metadata was discovered live from
`Microsoft.Chaos/locations/{region}/actions`, so a reader can tell the claim
came from the service rather than from a local list that may have drifted.

This section exists so the reader can judge whether the study asked a question
worth answering.

### 4. What happened

The run record, rendered: which action ran and over what, when, whether the
scenario run completed or aborted, and the observed signal values per window.

Each signal row shows source, window, value, and caveat. `mechanismProven` is
shown explicitly — a reader must be able to see whether the action was proven to
reach the data plane, or only accepted by the control plane.

### 5. Findings

Prioritised, highest severity first. Each finding carries:

- `severity` — `critical` / `high` / `medium` / `low`
- `confidence` — `high` / `medium` / `low`
- the **observation** (what the numbers say)
- the **interpretation** (what it means for the service)
- the **evidence** it rests on, by signal and window

A finding with no evidence reference is not a finding; it is a guess, and it
does not belong in the report.

### 6. Limitations

Mandatory and never empty. Drawn from the taxonomy:

| Code | Limitation |
|---|---|
| L1 | Scope — one action, one workspace scope, one window |
| L2 | Observability coverage — a signal source was unavailable |
| L3 | Mechanism unproven — control-plane success only |
| L4 | Sampling resolution — metric granularity coarser than the window |
| L5 | Environment — non-production or reduced-load conditions |
| L6 | Concurrency — other activity in the window could confound results |
| L7 | Duration — window too short to observe slow failure modes |
| L8 | Aborted — the run stopped early |
| L9 | Configuration drift — the plan changed between scope and run |
| L10 | Discovery unverified — action metadata not confirmed against the live action list |

L1 always applies. Others are added when their condition is detected.

### 7. Remediation

Actionable guidance tied to specific findings. Each item states what to change,
where, and what it would prevent. Generic advice ("add retries") is not
remediation; it is filler.

Remediation is advisory. Nothing in this suite applies it.

### 8. Appendix

Reproducibility material: study id, scope hash, frozen config hash, api-version
pins, artifact hashes from the manifest, and the redacted command trail.

This is what makes the report citable rather than merely readable.

## Verdict wording

| Verdict | Condition |
|---|---|
| `Steady state held` | no finding above `low` |
| `Degraded but recovered` | worst finding is `medium` or `high` |
| `Steady state breached` | any `critical` finding |
| `Inconclusive` | mechanism unproven, or no signal source covered the impact |

`Inconclusive` is a legitimate and useful outcome. It must never be reported as
a pass.
