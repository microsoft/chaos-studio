import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * E6-T3 — BEHAVIOURAL coverage for the `contract-drift` reporting step.
 *
 * The reporting job holds the workflow's only write permission and deliberately
 * has NO checkout, so its logic cannot be extracted into `scripts/lib/` and
 * `require`d: it must stay inline in the workflow. To test it anyway, the inline
 * `script:` block is read out of the workflow file and evaluated against fake
 * `github`/`context`/`core` objects — the same three globals `actions/github-script`
 * injects. That keeps the shipped artifact the single source of truth (a change to
 * the workflow is a change to what these tests run) while still exercising the
 * decision logic rather than its wording.
 *
 * The case under test: an issue opened by an EARLIER generation of this workflow,
 * whose title and body declare the mismatch a confirmed service defect. That
 * classification was withdrawn — the drift checks observe only this repository —
 * so a later run must not leave the stale verdict standing unqualified, and must
 * not silently overwrite triage a human has since added.
 */

const repoRootUrl = new URL('../../', import.meta.url);
const repoRoot = fileURLToPath(repoRootUrl);
const readText = (path: string): string =>
  readFileSync(new URL(path, repoRootUrl), 'utf8').replace(/\r\n/g, '\n');

/** The classification the previous generation of the workflow published. */
const LEGACY_TITLE =
  'contract-drift: the Microsoft.Chaos source contract no longer matches the shipped fixtures';
const LEGACY_BODY = [
  'The scheduled `contract-drift` workflow CONFIRMED a source-contract mismatch:',
  'the committed fixtures, the provenance manifest, or the pinned `api-version` no',
  'longer agree with each other or with the reviewed source extracts.',
  '',
  'Failing run: https://github.com/microsoft/chaos-studio/actions/runs/1',
  '',
  '**This is a service defect, not a client bug.** Per the release policy, a protocol',
  'mismatch is escalated to the Chaos Studio service team rather than silently',
  'accommodated in the client: do NOT regenerate fixtures, relax an assertion, or bump',
  'the pinned `api-version` to make this green.',
  '',
  'Triage steps are in `docs/runbooks/contract-drift.md`.',
].join('\n');

const RUN_URL = 'https://github.com/microsoft/chaos-studio/actions/runs/99';

/**
 * Extracts the reporting step's inline `script:` block from a workflow document
 * and returns it as source text. Failing to find it is itself a test failure:
 * the coverage below would otherwise pass vacuously.
 */
function extractScript(workflow: string): string {
  const report = workflow.slice(workflow.indexOf('\n  report:'));
  const marker = '\n          script: |\n';
  const start = report.indexOf(marker);
  assert.notEqual(start, -1, 'the reporting step still declares an inline `script:` block');

  const lines = report.slice(start + marker.length).split('\n');
  const first = lines[0] ?? '';
  const indent = /^\s*/.exec(first)![0];
  assert.ok(indent.length > 0, 'the inline script block is indented');

  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (!line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  const script = body.join('\n').trim();
  assert.ok(script.length > 0, 'the inline script block is non-empty');
  return script;
}

const loadReportScript = (): string => extractScript(readText('.github/workflows/contract-drift.yml'));

type Issue = {
  number: number;
  title: string;
  body: string;
  user?: { type: string };
};

type Call = { op: string; [key: string]: unknown };

type PageParams = { per_page?: number; page?: number };

/**
 * Runs the extracted script with fakes standing in for the three globals
 * `actions/github-script` provides, returning every REST call it made.
 */
async function runReport(options: {
  mismatch: boolean;
  existing?: Issue[];
  comments?: { body: string }[];
  /** Defaults to the shipped workflow; overridden to replay an older generation. */
  script?: string;
}): Promise<Call[]> {
  const calls: Call[] = [];
  const existing = options.existing ?? [];
  const comments = options.comments ?? [];

  const github = {
    // Mirrors Octokit's paginate: walks pages until a short one, so a script that
    // reads only the first page cannot pass a test whose marker sits beyond it.
    paginate: async (
      endpoint: (params: PageParams) => Promise<{ data: unknown[] }>,
      params: PageParams,
    ) => {
      const size = params.per_page ?? 30;
      const items: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const response = await endpoint({ ...params, page });
        items.push(...response.data);
        if (response.data.length < size) break;
      }
      return items;
    },
    rest: {
      issues: {
        listForRepo: async ({ labels, per_page, page }: PageParams & { labels: string }) => {
          calls.push({ op: 'listForRepo', labels, page: page ?? 1 });
          const size = per_page ?? 30;
          const start = ((page ?? 1) - 1) * size;
          return { data: existing.slice(start, start + size) };
        },
        listComments: async ({ issue_number, per_page, page }: PageParams & { issue_number: number }) => {
          calls.push({ op: 'listComments', issue_number, page: page ?? 1 });
          const size = per_page ?? 30;
          const start = ((page ?? 1) - 1) * size;
          return { data: comments.slice(start, start + size) };
        },
        createComment: async (args: { issue_number: number; body: string }) => {
          calls.push({ op: 'createComment', issue_number: args.issue_number, body: args.body });
          return { data: { id: 1 } };
        },
        update: async (args: { issue_number: number; title?: string; body?: string }) => {
          calls.push({
            op: 'update',
            issue_number: args.issue_number,
            title: args.title,
            body: args.body,
          });
          return { data: args };
        },
        create: async (args: { title: string; body: string; labels: string[] }) => {
          calls.push({ op: 'create', title: args.title, body: args.body, labels: args.labels });
          return { data: { number: 100 } };
        },
      },
    },
  };

  const context = { repo: { owner: 'microsoft', repo: 'chaos-studio' } };
  const core = { notice: (message: string) => calls.push({ op: 'notice', message }) };
  const env = { RUN_URL, CONTRACT_MISMATCH: options.mismatch ? 'true' : 'false' };

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction(
    'github',
    'context',
    'core',
    'process',
    options.script ?? loadReportScript(),
  );
  await fn(github, context, core, { env });
  return calls;
}

const commentsOn = (calls: Call[]) => calls.filter((call) => call.op === 'createComment');
const updatesOn = (calls: Call[]) => calls.filter((call) => call.op === 'update');

/** Returns the single call of `op`, failing the test when there is not exactly one. */
function onlyCall(calls: Call[], op: string, what: string): Call {
  const matched = calls.filter((call) => call.op === op);
  assert.equal(matched.length, 1, what);
  return matched[0]!;
}

// ---------------------------------------------------------------------------
// Baseline: the paths that must keep working.
// ---------------------------------------------------------------------------

test('with no open issue, a contract mismatch opens one carrying the triage classification', async () => {
  const calls = await runReport({ mismatch: true });
  const created = calls.find((call) => call.op === 'create');
  assert.ok(created, 'a new issue is opened');
  assert.deepEqual(created!.labels, ['contract-drift']);
  const body = String(created!.body);
  assert.match(body, /triage/i);
  assert.doesNotMatch(
    body,
    /This is a service defect/i,
    'a fresh report never declares a confirmed service defect',
  );
  assert.equal(updatesOn(calls).length, 0);
});

test('a current-generation issue only gets the recurrence comment', async () => {
  // Round-trip: whatever marker the shipped script stamps into a body it must also
  // recognize, so the current generation is never mistaken for a legacy one.
  const fresh = await runReport({ mismatch: true });
  const body = String(onlyCall(fresh, 'create', 'a fresh issue is opened').body);

  const calls = await runReport({
    mismatch: true,
    existing: [{ number: 7, title: 'contract-drift: …', body, user: { type: 'Bot' } }],
  });
  const posted = onlyCall(calls, 'createComment', 'exactly one comment — the recurrence note');
  assert.match(String(posted.body), /again/i);
  assert.equal(updatesOn(calls).length, 0, 'a current issue is never rewritten');
});

// ---------------------------------------------------------------------------
// The review finding: an issue left over from the previous generation.
// ---------------------------------------------------------------------------

test('a legacy, untouched service-defect issue is migrated to the corrected classification', async () => {
  const calls = await runReport({
    mismatch: true,
    existing: [{ number: 42, title: LEGACY_TITLE, body: LEGACY_BODY, user: { type: 'Bot' } }],
  });

  const updated = onlyCall(calls, 'update', 'the stale generated issue is rewritten');
  assert.equal(updated.issue_number, 42);
  const body = String(updated.body);
  assert.doesNotMatch(
    body,
    /This is a service defect, not a client bug/i,
    'the withdrawn verdict does not survive the migration',
  );
  assert.match(body, /triage/i, 'the corrected body asks for triage');
  assert.doesNotMatch(
    String(updated.title),
    /no longer matches the shipped fixtures/,
    'the stale title is replaced too',
  );
  // Still reported as recurring, so the run is not silently swallowed.
  assert.ok(commentsOn(calls).some((call) => /again/i.test(String(call.body))));
});

test('the migrated issue is left in the current generation, so the next run only comments', async () => {
  const first = await runReport({
    mismatch: true,
    existing: [{ number: 42, title: LEGACY_TITLE, body: LEGACY_BODY, user: { type: 'Bot' } }],
  });
  const migrated = onlyCall(first, 'update', 'the legacy issue is migrated');

  const second = await runReport({
    mismatch: true,
    existing: [
      {
        number: 42,
        title: String(migrated.title),
        body: String(migrated.body),
        user: { type: 'Bot' },
      },
    ],
  });
  assert.equal(updatesOn(second).length, 0, 'migration does not repeat on every scheduled run');
  assert.equal(commentsOn(second).length, 1);
});

test('human triage is never overwritten: a corrective notice is added instead', async () => {
  const triaged = [
    LEGACY_BODY,
    '',
    '---',
    '',
    'Triage (oncall): reproduced locally, investigating the fixture generator.',
  ].join('\n');

  const calls = await runReport({
    mismatch: true,
    existing: [
      {
        number: 42,
        title: `${LEGACY_TITLE} [investigating]`,
        body: triaged,
        user: { type: 'Bot' },
      },
    ],
  });

  assert.equal(updatesOn(calls).length, 0, 'an edited issue is never rewritten');
  const notice = commentsOn(calls).find((call) => /correction/i.test(String(call.body)));
  assert.ok(notice, 'a corrective triage notice is posted');
  const body = String(notice!.body);
  assert.match(body, /service defect/i, 'the notice names the classification it corrects');
  assert.match(body, /repository/i, 'the notice names the in-repo cause it was missing');
  assert.match(body, /do NOT regenerate fixtures/i, 'the client-behaviour policy is restated');
  assert.match(body, /docs\/runbooks\/contract-drift\.md/);
});

test('an issue opened by a human is never rewritten OR reclassified by the workflow', async () => {
  // Even a human issue that reproduces the old report exactly is not a report
  // this workflow filed, so the corrective notice — which asserts the issue "was
  // filed with a classification that has since been withdrawn" — would be a
  // false statement about someone else's issue.
  const calls = await runReport({
    mismatch: true,
    existing: [{ number: 43, title: LEGACY_TITLE, body: LEGACY_BODY, user: { type: 'User' } }],
  });
  assert.equal(updatesOn(calls).length, 0, 'only workflow-authored issues are migrated');
  assert.equal(
    commentsOn(calls).filter((call) => /correction/i.test(String(call.body))).length,
    0,
    'a human-filed issue is never told it was filed by an earlier workflow generation',
  );
});

test('a human issue quoting the complete legacy report in full is left alone', async () => {
  // Regression: matching the withdrawn verdict alone — or even every structural
  // line of the old report — cannot distinguish a generated report from a human
  // discussion that quotes one. This issue reproduces the ENTIRE legacy
  // signature while arguing against its verdict; reclassifying it would
  // contradict the argument its author is making.
  const quoted = [
    'Filing this because I disagree with the verdict the bot used to publish:',
    '',
    ...LEGACY_BODY.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)),
    '',
    'That classification was wrong — the checks only ever looked at this repo.',
  ].join('\n');

  const calls = await runReport({
    mismatch: true,
    existing: [
      {
        number: 44,
        title: 'Discussion: the drift report should not assert a service defect',
        body: quoted,
        user: { type: 'User' },
      },
    ],
  });
  assert.equal(updatesOn(calls).length, 0, 'a human issue is never rewritten');
  assert.equal(
    commentsOn(calls).length,
    0,
    'quoting the old report does not make it a report this workflow filed',
  );
  onlyCall(calls, 'create', 'the episode is reported on a new issue of its own');
});

test('a bot issue quoting only the withdrawn verdict is not treated as a generated report', async () => {
  // The verdict paragraph on its own is not evidence of generation: the rest of
  // the old report's structure has to be there too.
  const calls = await runReport({
    mismatch: true,
    existing: [
      {
        number: 45,
        title: 'automation digest: open drift topics',
        body: [
          'Carried over from last week:',
          '',
          '**This is a service defect, not a client bug.** Per the release policy, a protocol',
          'mismatch is escalated to the Chaos Studio service team.',
        ].join('\n'),
        user: { type: 'Bot' },
      },
    ],
  });
  assert.equal(updatesOn(calls).length, 0);
  assert.equal(commentsOn(calls).length, 0, 'a digest is not a report of this episode');
  onlyCall(calls, 'create', 'the episode is reported on a new issue of its own');
});

test('text appended to the generated run-URL line counts as human content', async () => {
  // Regression: normalizing the WHOLE `Failing run:` line would erase a triage note
  // written onto it, making an edited issue look pristine and get overwritten.
  const annotated = LEGACY_BODY.replace(
    /^Failing run: (\S+)$/m,
    'Failing run: $1 — reproduced locally against the fixture generator',
  );
  assert.notEqual(annotated, LEGACY_BODY, 'the fixture actually annotates the run line');

  const calls = await runReport({
    mismatch: true,
    existing: [{ number: 42, title: LEGACY_TITLE, body: annotated, user: { type: 'Bot' } }],
  });
  assert.equal(updatesOn(calls).length, 0, 'an annotated body is never overwritten');
  assert.ok(
    commentsOn(calls).some((call) => /correction/i.test(String(call.body))),
    'the stale classification is corrected in a comment instead',
  );
});

test('the corrective notice is found however far down the comment history it sits', async () => {
  // Regression: reading only the first page of comments would re-post the notice on
  // every scheduled run once an issue has accumulated a page of discussion.
  const legacyIssue = {
    number: 42,
    title: `${LEGACY_TITLE} [investigating]`,
    body: LEGACY_BODY + '\n\nTriage notes.',
    user: { type: 'Bot' },
  };
  const first = await runReport({ mismatch: true, existing: [legacyIssue] });
  const notice = commentsOn(first).find((call) => /correction/i.test(String(call.body)))!;

  const history = [
    ...Array.from({ length: 150 }, (_, index) => ({ body: `unrelated discussion ${index}` })),
    { body: String(notice.body) },
    ...Array.from({ length: 5 }, (_, index) => ({ body: `later discussion ${index}` })),
  ];

  const second = await runReport({ mismatch: true, existing: [legacyIssue], comments: history });
  const repeated = commentsOn(second).filter((call) => /correction/i.test(String(call.body)));
  assert.equal(repeated.length, 0, 'the correction is not re-posted from a later page');
  assert.ok(
    second.filter((call) => call.op === 'listComments').length > 1,
    'the comment history is paginated rather than read as a single page',
  );
});

/**
 * Fills a page with human-filed issues that carry the report label, so a
 * generated report placed after them lands beyond the first page.
 */
const labelledNoise = (count: number): Issue[] =>
  Array.from({ length: count }, (_, index) => ({
    number: 200 + index,
    title: `Discussion ${index}: drift report handling`,
    body: 'Filed by a person; carries the label after triage.',
    user: { type: 'User' },
  }));

test('a current-generation report beyond the first page is reused, not duplicated', async () => {
  const fresh = await runReport({ mismatch: true });
  const body = String(onlyCall(fresh, 'create', 'a fresh issue is opened').body);

  const calls = await runReport({
    mismatch: true,
    existing: [
      ...labelledNoise(100),
      { number: 7, title: 'contract-drift: …', body, user: { type: 'Bot' } },
    ],
  });

  assert.equal(
    calls.filter((call) => call.op === 'create').length,
    0,
    'a report on a later page is found rather than duplicated',
  );
  const posted = onlyCall(calls, 'createComment', 'exactly one comment — the recurrence note');
  assert.match(String(posted.body), /again/i);
  assert.ok(
    calls.filter((call) => call.op === 'listForRepo').length > 1,
    'the issue list is paginated rather than read as a single page',
  );
});

test('a legacy report beyond the first page is migrated, not duplicated', async () => {
  const calls = await runReport({
    mismatch: true,
    existing: [
      ...labelledNoise(100),
      { number: 42, title: LEGACY_TITLE, body: LEGACY_BODY, user: { type: 'Bot' } },
    ],
  });

  assert.equal(
    calls.filter((call) => call.op === 'create').length,
    0,
    'a legacy report on a later page is migrated rather than duplicated',
  );
  const updated = onlyCall(calls, 'update', 'the stale generated issue is rewritten');
  assert.equal(updated.issue_number, 42);
  assert.doesNotMatch(
    String(updated.body),
    /This is a service defect, not a client bug/i,
    'the withdrawn verdict does not survive the migration',
  );
});

test('the corrective notice is posted once, not on every scheduled run', async () => {
  const first = await runReport({
    mismatch: true,
    existing: [
      { number: 42, title: `${LEGACY_TITLE} [investigating]`, body: LEGACY_BODY + '\n\nnotes', user: { type: 'Bot' } },
    ],
  });
  const notice = commentsOn(first).find((call) => /correction/i.test(String(call.body)))!;

  const second = await runReport({
    mismatch: true,
    existing: [
      { number: 42, title: `${LEGACY_TITLE} [investigating]`, body: LEGACY_BODY + '\n\nnotes', user: { type: 'Bot' } },
    ],
    comments: [{ body: String(notice.body) }],
  });
  const repeated = commentsOn(second).filter((call) => /correction/i.test(String(call.body)));
  assert.equal(repeated.length, 0, 'the correction is not re-posted');
  assert.equal(commentsOn(second).length, 1, 'only the recurrence comment remains');
});

test('the workflow-failure report is never treated as a stale mismatch classification', async () => {
  // Its wording did NOT change between generations, so it must not attract a
  // correction notice or a rewrite just for predating the classification marker.
  const legacyWorkflowFailure = [
    'The scheduled `contract-drift` workflow failed, but it did NOT confirm a source-contract mismatch.',
    '',
    `Failing run: ${RUN_URL}`,
  ].join('\n');

  const calls = await runReport({
    mismatch: false,
    existing: [
      {
        number: 8,
        title: 'contract-drift: the scheduled drift check could not complete',
        body: legacyWorkflowFailure,
        user: { type: 'Bot' },
      },
    ],
  });

  assert.equal(updatesOn(calls).length, 0);
  const posted = onlyCall(calls, 'createComment', 'only the recurrence comment');
  assert.doesNotMatch(String(posted.body), /correction/i);
});

/** A human-filed issue that happens to carry the report label. */
const UNRELATED_ISSUE: Issue = {
  number: 9,
  title: 'Discussion: should drift reports be auto-closed?',
  body: 'We should revisit the old "This is a service defect, not a client bug." wording.',
  user: { type: 'User' },
};

test('an unrelated issue carrying the drift label is not rewritten', async () => {
  // A human-filed issue that merely discusses the old wording must not be
  // mistaken for a generated one.
  const calls = await runReport({ mismatch: true, existing: [UNRELATED_ISSUE] });
  assert.equal(updatesOn(calls).length, 0, 'a human issue is never rewritten');
});

// ---------------------------------------------------------------------------
// Report SELECTION: carrying the label is not evidence of being a report.
// Deduplication must key off a report this workflow actually generated, or the
// episode goes unreported behind an unrelated issue that merely shares a label.
// ---------------------------------------------------------------------------

test('an unrelated labeled issue is not commented on and does not suppress the report', async () => {
  const calls = await runReport({ mismatch: true, existing: [UNRELATED_ISSUE] });

  assert.equal(
    commentsOn(calls).length,
    0,
    'a human issue gets no recurrence comment — it is not a report of this episode',
  );
  const created = onlyCall(calls, 'create', 'the actual triage report is still opened');
  assert.deepEqual(created.labels, ['contract-drift']);
  assert.match(String(created.body), /triage/i);
});

test('an unrelated labeled issue listed first does not hide a real generated report', async () => {
  // Selection must scan for provenance rather than take the first result, whose
  // order the issues API does not guarantee to put a generated report at.
  const fresh = await runReport({ mismatch: true });
  const body = String(onlyCall(fresh, 'create', 'a fresh issue is opened').body);

  const calls = await runReport({
    mismatch: true,
    existing: [UNRELATED_ISSUE, { number: 11, title: 'contract-drift: …', body, user: { type: 'Bot' } }],
  });

  assert.equal(calls.filter((call) => call.op === 'create').length, 0, 'the open report is reused');
  const posted = onlyCall(calls, 'createComment', 'exactly one recurrence comment');
  assert.equal(posted.issue_number, 11, 'the recurrence lands on the generated report');
  assert.match(String(posted.body), /again/i);
});

test('an unrelated labeled issue listed first does not hide a legacy generated report', async () => {
  const calls = await runReport({
    mismatch: true,
    existing: [UNRELATED_ISSUE, { number: 42, title: LEGACY_TITLE, body: LEGACY_BODY, user: { type: 'Bot' } }],
  });

  const updated = onlyCall(calls, 'update', 'the legacy report behind the unrelated issue is migrated');
  assert.equal(updated.issue_number, 42);
  assert.equal(calls.filter((call) => call.op === 'create').length, 0);
  assert.ok(commentsOn(calls).every((call) => call.issue_number === 42));
});

test('a labeled issue opened by a bot but not shaped like a report is not treated as one', async () => {
  // Bot authorship alone is not provenance: other automation files issues too.
  const calls = await runReport({
    mismatch: true,
    existing: [
      {
        number: 12,
        title: 'dependabot: bump actions/checkout',
        body: 'Bumps `actions/checkout`. Mislabeled `contract-drift` by a triage rule.',
        user: { type: 'Bot' },
      },
    ],
  });

  assert.equal(commentsOn(calls).length, 0, 'unrelated automation gets no recurrence comment');
  assert.equal(updatesOn(calls).length, 0);
  onlyCall(calls, 'create', 'the actual triage report is still opened');
});

test('an unrelated labeled issue does not suppress the workflow-failure report', async () => {
  const calls = await runReport({
    mismatch: false,
    existing: [{ ...UNRELATED_ISSUE, title: 'Why did the drift workflow fail last week?' }],
  });

  assert.equal(commentsOn(calls).length, 0);
  const created = onlyCall(calls, 'create', 'the workflow-failure report is still opened');
  assert.deepEqual(created.labels, ['contract-drift-workflow-failure']);
});

// ---------------------------------------------------------------------------
// Non-tautology guard: the legacy template is checked against the REAL previous
// generation, replayed from an independently preserved copy of that workflow.
//
// The copy is a committed fixture rather than a `git log` search, for two
// reasons. A search is unsound: the CURRENT workflow quotes the withdrawn
// wording verbatim (it has to, to recognize a stale issue), so scanning history
// for that wording selects HEAD and the guard degrades into comparing the
// template with itself. And it is unavailable: every job that runs this suite
// uses a default shallow checkout, which has no history to search, so a
// history-dependent assertion would fail scheduled runs on healthy artifacts.
// The fixture is byte-identical to the blob named below; `git` is used only to
// re-confirm that when full history happens to be present.
// ---------------------------------------------------------------------------

/** The last revision whose reporting step published the withdrawn verdict. */
const LEGACY_GENERATION_REV = '69ebe4e121da47a9e01d520aa9092133706b0337';
const LEGACY_GENERATION_PATH = 'test/release-validation/fixtures/contract-drift.legacy-generation.yml';

test('the legacy template matches the issue the previous workflow generation actually wrote', async () => {
  const legacySource = readText(`./${LEGACY_GENERATION_PATH}`);

  // The fixture is a PRIOR generation, established from what it emits rather
  // than from its source text: it publishes the withdrawn verdict as its own
  // report and carries no classification marker. A copy of the current workflow
  // could not satisfy both.
  const legacyCalls = await runReport({ mismatch: true, script: extractScript(legacySource) });
  const legacyIssue = onlyCall(legacyCalls, 'create', 'the previous generation opened a mismatch issue');
  assert.match(
    String(legacyIssue.body),
    /\*\*This is a service defect, not a client bug\.\*\*/,
    'the preserved generation really did publish the withdrawn verdict',
  );
  assert.doesNotMatch(
    String(legacyIssue.body),
    /contract-drift:classification=triage-required/,
    'the preserved generation predates the classification marker',
  );

  // Hand that exact issue to the CURRENT script: it must be recognized and migrated.
  const calls = await runReport({
    mismatch: true,
    existing: [
      {
        number: 42,
        title: String(legacyIssue.title),
        body: String(legacyIssue.body),
        user: { type: 'Bot' },
      },
    ],
  });
  const updated = onlyCall(calls, 'update', 'a genuinely legacy issue is recognized and migrated');
  assert.doesNotMatch(String(updated.body), /This is a service defect, not a client bug/i);
});

test('the preserved legacy generation is the historical artifact it claims to be', () => {
  // Corroboration only. Shallow checkouts (every job that runs this suite) have
  // no history, so an unreachable revision is not a failure — the replay above
  // is the guard. When history IS present the fixture must match the blob
  // exactly, so it cannot be quietly rewritten into a copy of the current file.
  const reachable = spawnSync('git', ['cat-file', '-e', `${LEGACY_GENERATION_REV}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (reachable.status !== 0) return;

  const historical = spawnSync(
    'git',
    ['rev-parse', `${LEGACY_GENERATION_REV}:.github/workflows/contract-drift.yml`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(historical.status, 0, `the pinned revision still carries the workflow: ${historical.stderr}`);

  const fixture = spawnSync('git', ['hash-object', LEGACY_GENERATION_PATH], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(fixture.status, 0, `hashing the fixture failed: ${fixture.stderr}`);
  assert.equal(
    fixture.stdout.trim(),
    historical.stdout.trim(),
    'the preserved fixture is byte-identical to the workflow at the pinned revision',
  );
});
