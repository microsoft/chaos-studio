# Source-contract fixture provenance

The fixtures in this directory encode the current `Microsoft.Chaos`
`2026-05-01-preview` wire protocol (validate / execute / cancel acceptance, the
validation and run resources, their `200`/`202` and dual error-channel shapes,
and the generated provider-operation strings). The contract tests compare
`packages/core/src/contract.ts` constants against these fixtures.

A fixture and the contract constant it is compared against are both maintained
in this repository, so on their own they could drift together and be wrong
together. To narrow that gap, the source-of-truth protocol is captured as
**reviewed representative extracts** under
[`source-extracts/`](source-extracts/README.md), and **both** the contract
constants **and** the fixtures are authenticated against those extracts. Every
fixture is also bound to a **commit-pinned source-of-truth artifact** and a
**canonical content hash**.

> **Scope of the extracts (important).** This is the **public** `microsoft/chaos-studio`
> repository, which does **not** contain the internal `Squall` GW/BE source. The files
> under `source-extracts/` are therefore **reviewed representative extracts authored for
> this integration** — they faithfully encode the *relevant structure and behavior* of
> the generated `2026-05-01-preview` artifacts (enum members, serialized wire fields and
> channels, domain-logic control flow, the operation set) and carry brief explanatory
> commentary. They are **not** byte-for-byte copies of the upstream files, and the
> `extractSha256` values are **in-repo tamper-evidence for the reviewed extract**, not an
> independent attestation of upstream bytes. Authenticity of the *content* rests on the
> one-time human review against the commit-pinned permalink (below); the machine checks
> then prove `contract.ts` and the fixtures agree with the reviewed extract.

## How it works

1. **Embedded provenance.** Each fixture carries a `provenance` block naming the
   authoritative source it is derived from and the verified findings it encodes:

   ```json
   "provenance": { "source": "gw.run.state", "citation": "VF6, VF7" }
   ```

2. **Commit-pinned source registry.** `provenance.manifest.json#/sources` records
   the exact GW/BE artifact behind each `source` key — a generated model/enum
   (`*.g.cs`) or generated operation snapshot at the pinned `V2026_05_01_preview`
   path, a version-agnostic V1 domain-logic file, or a BE command handler. Each
   entry declares its evidence tier (1/2 of the plan's source-of-truth hierarchy)
   and pinned API version, and is bound to an **immutable monorepo revision**:
   `provenance.manifest.json#/sourceSnapshot.commitId` pins the internal `Squall`
   commit the generated `2026-05-01-preview` artifacts were captured from, and
   each source carries that `commitId` plus a commit-pinned `url` permalink that
   pins both the commit and the artifact path.

3. **Reviewed source extracts (the in-repo authority).** Each generated source
   also records an `extract` — a committed **reviewed representative extract** under
   `source-extracts/` — and its line-ending-normalized `extractSha256`. A reviewer
   with monorepo access **follows the permalink once** and confirms the committed
   extract **faithfully represents** the real generated artifact at the pinned
   revision (its enum members, serialized fields/channels, control flow, and
   operation strings — not a byte-for-byte diff, since the extract carries
   explanatory commentary). That single out-of-band step makes the extract's
   *content* trustworthy; from then on CI mechanically proves the contract and the
   fixtures agree with it.

4. **Content hashes (in-repo tamper-evidence).**
   `provenance.manifest.json#/fixtures[*].canonicalSha256` records a canonical
   hash (whitespace/line-ending independent) of each fixture, and each source's
   `extractSha256` guards its committed extract. These hashes are **in-repo
   tamper-evidence** — they prove neither a fixture nor a reviewed extract can change
   without a reviewable manifest hash change; they are **not** a claim that the
   extract equals upstream bytes (that judgment is the human review in step 3).

5. **Reproducible authentication + independent verification.**
   `../test/contract/provenance.test.ts` re-derives the fixture list, hashes, and
   source bindings from disk and asserts the committed manifest matches. It then
   **parses the reviewed extracts** and asserts that both `contract.ts` and the
   fixtures encode exactly what the source contains: the enum wire values
   (`VALIDATION_STATES`/`RUN_STATES`), the serialized wire field names and the
   dual error channels, and — in `operations.test.ts` — the **exact** provider
   operation set. It additionally cross-checks every fixture's wire facts (API
   version, states, error channels, `Retry-After`, run-ID GUID shape) against the
   reviewed `contract.ts`. All of this is reproducible with no network access.

## Regenerating the manifest

After intentionally changing a fixture or a source extract (to track a genuine
source-contract change), regenerate the manifest so its hashes and bindings
match:

```sh
node packages/core/fixtures/scripts/generate-provenance.mjs
```

Adding a new fixture also requires adding its `source` key to the `SOURCES`
registry in that script if it references a source not already declared.
