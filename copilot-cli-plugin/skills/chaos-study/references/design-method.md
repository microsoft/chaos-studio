# The design method — choosing a study worth running

Read this before `chaos-study-design` if you want to know *why* the phase refuses
things. The mechanics are in that skill's `SKILL.md`; this is the reasoning.

## The failure this phase exists to prevent

A team wants to "test resilience". Someone opens the action list, finds one that
sounds dramatic, runs it against a scope, watches a dashboard stay flat, and
writes it up as a pass.

Every step of that is defensible in isolation and the conclusion is worthless.
The action may never have touched a code path the request flow depends on. The
window may have been too short for a single vulnerable event to occur. The
predicate may have been unbreakable by construction. The signal may not have been
wired to the dependency under test. A flat dashboard is compatible with a
resilient system *and* with an experiment that tested nothing, and a report that
cannot tell those apart is worse than no report, because it retires a risk that
was never examined.

So the phase asks two questions, in this order and no other: **what does this
system actually depend on?** and **what does this customer actually want to
learn?**

## Why analysis comes first

Interview-first designs produce hypotheses shaped by whatever the customer
happened to think of that morning. They also waste the customer's time on
questions the repository answers better: which services call which, whether the
HTTP client retries, where state is written, what metrics already exist.

Worse, an interview-first hypothesis has no evidentiary anchor. "We think the
payment dependency is fragile" is a feeling. "`PaymentGateway.Charge()` at
`src/Orders/PaymentGateway.cs:14` issues a synchronous call inside the checkout
request path with no timeout and no retry policy" is a claim someone can check,
argue with, and design a probe for.

Eight areas are read: **code**, **deployment**, **dependencies**, **resilience**
behaviour, **persistence**, **workload**, **telemetry**, **identity**. Together
they cover what can break, where it runs, what it talks to, what it does when a
call fails, what it might lose, how much traffic crosses the path, whether the
effect could even be seen, and whether the platform can be asked at all.

## Why unavailable must be said out loud

The tempting shortcut is to analyse what is easy to reach and stay quiet about
the rest. That produces a confident-looking brief whose confidence is
counterfeit: nobody reading it can tell which parts rest on evidence and which
rest on nothing.

So each area is *observed with a citation* or *declared unavailable with a
reason*, and silence is a hard failure (exit `24`). "No access to the
subscription from this session" is a perfectly good answer. Saying nothing is
not. The difference matters later, because a candidate whose mechanism evidence
came from an area marked unavailable cannot honestly claim high confidence.

## Why the interview is adversarial

"Test resilience" cannot be falsified, cannot be scoped, and cannot be reported
on. Accepting it as a goal guarantees a worthless study, so the phase does not
accept it — and it does not accept the next four rephrasings of it either.

Four questions are **grounded**: the answer has to engage with the customer's own
system vocabulary — the services, dependencies and signals analysis actually
found. This is a deliberately awkward requirement. It is also the whole point: a
customer who cannot yet say which dependency they are worried about, in their own
words, is not ready to spend a maintenance window finding out.

Refusal is not an error. The question stays open, the refusal is recorded in the
transcript, and the exit code says *incomplete*, not *failed*. The transcript
matters: a study whose purpose was extracted after three attempts is a different
artifact from one whose purpose arrived fully formed, and the report should be
able to show that.

Equally, the phase never asks what analysis already established. A question with
an `establishedBy` reference is pre-filled from the corresponding analysis area.
Asking a customer to confirm their own deployment topology, when it was read from
their IaC five minutes earlier, spends trust for nothing.

## What makes a candidate a candidate

Eight fields are mandatory, and each earns its place by blocking a specific way
studies go wrong:

| Field | Without it |
|---|---|
| dependency edge | the study tests a component, not a relationship, and cannot generalise |
| failure mechanism | nobody can say *why* the action should matter |
| mechanism evidence | the mechanism is an opinion |
| mechanism probe | "nothing moved" is unfalsifiable |
| steady-state predicate | there is no way to be wrong |
| exposure inputs | a clean run may simply mean nothing was exercised |
| collateral risks | the blast radius is discovered during the run |
| abort criteria | there is no agreed stopping point under pressure |

Ranking is deliberately boring: platform availability first, then confidence,
then how much evidence backs it, then whether exposure is computable at all. A
brilliant hypothesis for an action the region does not offer is not the one to
run first.

## Why the platform is asked, never assumed

Candidates are intersected with live regional action discovery, the workspace's
discovered resources, and its recommended scenarios. A bundled catalogue would go
stale silently and would let a brief promise something the service cannot do.

When Azure cannot be reached, candidates are marked **provisional**, limitation
`L15` is recorded, and the brief says platform availability is unconfirmed. This
is strictly better than a plausible guess, because a provisional brief hands off
to live discovery and gets corrected, while a guess hands off a wrong answer that
looks right.

## Why confirmation is a phrase, not a flag

The recommendation is the moment the study's purpose and its risk envelope stop
being negotiable. A boolean `-Confirm` would be satisfiable by a caller that
never showed the customer anything.

The phrase is bound to the brief hash, so it can only be produced by someone who
saw *this* recommendation over *this* analysis. On confirmation the brief seals:
later writes exit `13`. The scope phase can then trust that what it reads is what
the customer agreed to, which is exactly the property that makes handing off the
brief safer than retyping its contents.

## The seam to scope

The brief carries purpose, selected hypothesis, failure mechanism, mechanism
evidence, mechanism probe, steady-state predicate, signals, exposure inputs,
scenario and action selection or discovery constraints, parameters, blast-radius
filters and exclusions, windows, abort criteria, risk and consent notes,
unresolved questions, and the customer's confirmations.

`chaos-study-scope -Brief <path>` hydrates any parameter not given explicitly on
the command line. Explicit arguments always win, so the brief is a starting point
rather than a cage — but nothing silently changes shape in transit, and the plan
that gets frozen is traceable to the conversation that produced it.

One honest limit: abort criteria have no platform enforcement hook. They are
carried as an operator instruction and labelled as such, rather than implying the
service will stop the run on the customer's behalf.
