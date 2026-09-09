import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression tests for the ref-name FNM_PATHNAME matcher embedded in the release
// workflows' tag-ruleset preflights. The matcher is INLINE `node -e '...'` inside the
// isolated, repo-code-free publish jobs (it cannot import a repo module by design), so
// these tests extract the ACTUAL committed evaluator from each workflow YAML and run it
// against synthetic rulesets. They pin the Ruby File.fnmatch semantics — in particular
// that a TERMINAL `**` is NOT recursive, so a `refs/**` rule does NOT protect a nested
// tag ref like refs/tags/v1.2.3 (the reviewed defect).

const WORKFLOWS = new URL('../../../../.github/workflows/', import.meta.url);

/** Returns the leading-space count of a line (its indentation column). */
function indentOf(line: string): number {
  const m = /^( *)/.exec(line);
  return m ? m[1]!.length : 0;
}

interface ParsedStep { name: string; run: string | null; }

const isBlank = (l: string) => /^\s*$/.test(l);
const isComment = (l: string) => /^\s*#/.test(l);

function reEsc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

interface BlockHeader { style: '|' | '>'; chomp: '' | '-' | '+'; indent: number; }

/** Parses a YAML block-scalar header (the text after `key:`), e.g. `|`, `>-`, `|2`, `|2-`,
 *  `|-2`. Returns the style (literal `|` / folded `>`), the chomping indicator (strip `-`,
 *  keep `+`, or clip ``), and the explicit indentation indicator (0 = auto-detect). Returns
 *  null when `val` is NOT a block-scalar header (a plain/quoted inline value). The chomping
 *  and indentation indicators may appear in EITHER order (YAML permits `|2-` and `|-2`). */
function parseBlockHeader(val: string): BlockHeader | null {
  const t = val.trim();
  const m = /^([|>])(?:([1-9])([+-]?)|([+-])([1-9]?))?$/.exec(t);
  if (!m) return null;
  const style = m[1] as '|' | '>';
  if (m[2]) return { style, indent: parseInt(m[2]!, 10), chomp: (m[3] || '') as '' | '-' | '+' };
  if (m[4]) return { style, chomp: m[4] as '-' | '+', indent: m[5] ? parseInt(m[5]!, 10) : 0 };
  return { style, chomp: '', indent: 0 };
}

/** Folds a YAML `>` (folded) scalar's already-dedented body lines: a single break between
 *  two non-empty, non-more-indented lines becomes a SPACE; blank lines and more-indented
 *  ("literal") lines keep their newlines. */
function foldScalar(bodyLines: string[]): string {
  let out = '';
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i]!;
    if (i === 0) { out = line; i++; continue; }
    if (line === '') {
      // A run of k blank lines yields k line breaks; the fold before them is absorbed.
      let blanks = 0;
      while (i < bodyLines.length && bodyLines[i] === '') { blanks++; i++; }
      out += '\n'.repeat(blanks);
      if (i < bodyLines.length) { out += bodyLines[i]!; i++; }
      continue;
    }
    const prev = bodyLines[i - 1]!;
    // A break next to a more-indented ("literal") line is kept; otherwise it folds to a space.
    if (/^\s/.test(line) || /^\s/.test(prev)) out += '\n' + line;
    else out += ' ' + line;
    i++;
  }
  return out;
}

/** Collect a YAML block scalar's content per the header: the run of lines indented deeper
 *  than the block KEY (or, with an explicit indentation indicator, at keyIndent+indicator),
 *  dedented by the content indentation, then folded (for `>`) and chomped (strip/keep/clip)
 *  conformantly. A non-empty line LESS indented than the content indent ENDS the block.
 *  Returns [text, indexOfFirstLineAfterBlock]. */
function collectBlockScalar(lines: string[], keyIndent: number, startIdx: number, header: BlockHeader): [string, number] {
  const n = lines.length;
  let k = startIdx;
  const contentLines: string[] = [];
  let contentIndent = header.indent > 0 ? keyIndent + header.indent : -1;
  while (k < n) {
    const bl = lines[k]!;
    if (isBlank(bl)) { contentLines.push(''); k++; continue; }
    const ind = indentOf(bl);
    if (ind <= keyIndent) break;
    if (contentIndent < 0) contentIndent = ind; // auto-detect from the first content line
    if (ind < contentIndent) break;             // a less-indented non-empty line ends the block
    contentLines.push(bl.slice(contentIndent));
    k++;
  }
  // Split off the trailing run of blank lines so chomping can treat them per the indicator.
  let end = contentLines.length;
  while (end > 0 && contentLines[end - 1] === '') end--;
  const bodyLines = contentLines.slice(0, end);
  const trailingBlanks = contentLines.length - end;

  let text = header.style === '>' ? foldScalar(bodyLines) : bodyLines.join('\n');
  if (header.chomp === '-') {
    // strip: no trailing line breaks.
  } else if (header.chomp === '+') {
    text += '\n'.repeat(1 + trailingBlanks); // keep: final break + every trailing blank line
  } else if (bodyLines.length > 0) {
    text += '\n'; // clip: a single trailing line break
  }
  return [text, k];
}

/** [start, end) line range of a mapping KEY's nested block: the lines after the key up to
 *  (but excluding) the first non-blank/comment line indented <= the key. */
function blockRange(lines: string[], keyIdx: number, keyIndent: number): [number, number] {
  const n = lines.length;
  let e = n;
  for (let i = keyIdx + 1; i < n; i++) {
    if (isBlank(lines[i]!) || isComment(lines[i]!)) continue;
    if (indentOf(lines[i]!) <= keyIndent) { e = i; break; }
  }
  return [keyIdx + 1, e];
}

/** Indent of the first non-blank/comment line within [start, end). */
function firstKeyIndent(lines: string[], start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (isBlank(lines[i]!) || isComment(lines[i]!)) continue;
    return indentOf(lines[i]!);
  }
  return -1;
}

/** Strips surrounding quotes from a simple inline YAML scalar. */
function stripYamlScalar(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Scans the document for TOP-LEVEL (column 0) mapping keys while SKIPPING block scalars at
 *  every depth, and returns the index of the single `jobs:` key. Requires EXACTLY ONE
 *  top-level `jobs:` mapping — a `jobs:` (or `steps:`/`- name:`) that appears INSIDE a block
 *  scalar (e.g. the text of a `run:` script) is consumed as data and can never shadow the
 *  real workflow, and a second top-level `jobs:` (a duplicate mapping key) is rejected. */
function findTopLevelJobsIndex(lines: string[], label: string): number {
  const n = lines.length;
  const found: number[] = [];
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (isBlank(line) || isComment(line)) { i++; continue; }
    const m = /^(\s*)([^\s#][^:]*):\s?(.*)$/.exec(line);
    if (m && parseBlockHeader(m[3]!)) {
      // A block scalar value: skip ALL of its content (lines indented deeper than the key)
      // so nothing inside it is ever read as document structure.
      i = blockRange(lines, i, m[1]!.length)[1];
      continue;
    }
    if (m && m[1]!.length === 0 && m[2]!.trim() === 'jobs') found.push(i);
    i++;
  }
  assert.equal(found.length, 1, `${label}: expected EXACTLY ONE top-level 'jobs:' mapping, found ${found.length}`);
  return found[0]!;
}

/** Parses `jobs.<jobId>.steps` from a workflow document and returns each step's `name` and
 *  its DIRECT `run:` scalar (block or single-line). Extraction is JOB-SCOPED (a step in
 *  ANOTHER job is never returned) and only a `run:` that is a DIRECT key of the step mapping
 *  is captured — a `run:` nested under `with:` (or any deeper mapping) is IGNORED. YAML
 *  block scalars (`key: |`, `key: >`, with optional `-`/`+`/digit indicators) are consumed
 *  as DATA so their text can never be mistaken for workflow structure. */
function parseJobSteps(raw: string, jobId: string, label: string): ParsedStep[] {
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));

  // The one top-level `jobs:` mapping (column 0), resolved with document-wide block-scalar
  // skipping so a scalar containing a fake `jobs:` cannot shadow the real workflow.
  const jobsIdx = findTopLevelJobsIndex(lines, label);
  const jobsIndent = 0;
  const [jobsStart, jobsEnd] = blockRange(lines, jobsIdx, jobsIndent);

  // jobs.<jobId> — a DIRECT child key of jobs (never a deeper/nested key of the same name).
  const jobKeyIndent = firstKeyIndent(lines, jobsStart, jobsEnd);
  const jobRe = new RegExp('^\\s*' + reEsc(jobId) + ':\\s*$');
  let jobIdx = -1;
  for (let i = jobsStart; i < jobsEnd; i++) {
    if (isBlank(lines[i]!) || isComment(lines[i]!)) continue;
    if (indentOf(lines[i]!) !== jobKeyIndent) continue;
    if (jobRe.test(lines[i]!)) { jobIdx = i; break; }
  }
  assert.ok(jobIdx >= 0, `${label}: job ${JSON.stringify(jobId)} not found as a direct child of jobs:`);
  const [jobStart, jobEnd] = blockRange(lines, jobIdx, jobKeyIndent);

  // <job>.steps — a DIRECT child key of the job.
  const jobChildIndent = firstKeyIndent(lines, jobStart, jobEnd);
  let stepsIdx = -1;
  for (let i = jobStart; i < jobEnd; i++) {
    if (isBlank(lines[i]!) || isComment(lines[i]!)) continue;
    if (indentOf(lines[i]!) !== jobChildIndent) continue;
    if (/^\s*steps:\s*$/.test(lines[i]!)) { stepsIdx = i; break; }
  }
  assert.ok(stepsIdx >= 0, `${label}: job ${JSON.stringify(jobId)} has no direct steps:`);
  const [stepsStart, stepsEnd] = blockRange(lines, stepsIdx, jobChildIndent);

  // The list-item indent (the `-` column) and the step mapping-key indent (two in from `-`).
  const itemIndent = firstKeyIndent(lines, stepsStart, stepsEnd);
  const keyIndent = itemIndent + 2;

  const steps: ParsedStep[] = [];
  let cur: ParsedStep | null = null;
  let i = stepsStart;
  while (i < stepsEnd) {
    const line = lines[i]!;
    if (isBlank(line) || isComment(line)) { i++; continue; }
    const ind = indentOf(line);

    // A `- ...` list item at itemIndent starts a new step; normalize the "- " to two spaces
    // so the first inline key aligns at keyIndent and is handled uniformly below.
    const dashM = /^(\s*)-\s+(.*)$/.exec(line);
    let keyLine: string | null = null;
    if (dashM && dashM[1]!.length === itemIndent) {
      cur = { name: '', run: null };
      steps.push(cur);
      keyLine = ' '.repeat(keyIndent) + dashM[2]!;
    } else if (ind === keyIndent) {
      keyLine = line;
    } else {
      // Deeper than a step key (nested mapping such as with:, or block-scalar content) is
      // DATA — a nested `with.run` therefore never becomes the step's run.
      i++;
      continue;
    }

    const km = /^(\s*)([^\s#:][^:]*):\s?(.*)$/.exec(keyLine);
    if (!km || !cur) { i++; continue; }
    const key = km[2]!.trim();
    const val = km[3]!;
    const header = parseBlockHeader(val);
    if (header) {
      const [content, next] = collectBlockScalar(lines, keyIndent, i + 1, header);
      if (key === 'run' && cur.run === null) cur.run = content;
      i = next;
      continue;
    }
    if (key === 'name' && cur.name === '') cur.name = stripYamlScalar(val);
    else if (key === 'run' && cur.run === null && val.trim() !== '') cur.run = stripYamlScalar(val);
    i++;
  }
  return steps;
}

/** Locates the embedded `node -e '<script>'` evaluator inside an already-parsed DIRECT
 *  `run:` shell scalar. Requires EXACTLY ONE ANCHORED opener line (`node -e '` alone on its
 *  line). Per POSIX single-quote semantics the FIRST single quote after the opener closes
 *  the string, so the first quote-bearing line MUST be a LONE closing quote — an inline
 *  apostrophe in the body, a premature/decoy earlier closer, or a command glued to the
 *  closer are all rejected. NO trailing shell command may follow the closer (the evaluator
 *  must be the terminal command so its exit status is the step's status). */
function extractEvaluatorFromRun(runText: string | null, label: string, stepName: string): string {
  assert.ok(runText !== null, `${label}: step ${JSON.stringify(stepName)} has no direct run: scalar (a nested with.run is not accepted)`);
  const lines = runText.split('\n');
  const openers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*node -e '$/.test(lines[i]!)) openers.push(i);
  }
  assert.equal(
    openers.length,
    1,
    `${label}: step ${JSON.stringify(stepName)} must contain EXACTLY ONE anchored "node -e '" opener line, found ${openers.length}`,
  );
  const openIdx = openers[0]!;

  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i]!.includes("'")) { closeIdx = i; break; }
  }
  assert.ok(
    closeIdx > openIdx,
    `${label}: step ${JSON.stringify(stepName)} evaluator is unterminated (no closing quote after the opener)`,
  );
  assert.ok(
    /^\s*'\s*$/.test(lines[closeIdx]!),
    `${label}: step ${JSON.stringify(stepName)} evaluator closer is not a lone quote (inline apostrophe in the body, a premature/decoy closer, or a command glued to the closer)`,
  );
  for (let i = closeIdx + 1; i < lines.length; i++) {
    assert.ok(
      /^\s*(#.*)?$/.test(lines[i]!),
      `${label}: step ${JSON.stringify(stepName)} has a trailing command after the evaluator closer: ${JSON.stringify(lines[i])}`,
    );
  }

  const script = lines.slice(openIdx + 1, closeIdx).join('\n');
  assert.ok(
    !script.includes("'"),
    `${label}: step ${JSON.stringify(stepName)} evaluator body must contain no single quote`,
  );
  return script;
}

/** Extracts the tag-ruleset-preflight evaluator from a workflow, SCOPED to `jobs.<jobId>`
 *  and the single step whose `- name:` contains `stepNameSubstring`. The step must exist
 *  EXACTLY ONCE within that job; its DIRECT `run:` scalar is parsed and the evaluator
 *  located within it. */
function extractEvaluator(workflowFile: string, jobId: string, stepNameSubstring: string): string {
  const raw = readFileSync(fileURLToPath(new URL(workflowFile, WORKFLOWS)), 'utf8');
  return parseEvaluatorFromStep(raw, jobId, stepNameSubstring, workflowFile);
}

function parseEvaluatorFromStep(raw: string, jobId: string, stepNameSubstring: string, label: string): string {
  const steps = parseJobSteps(raw, jobId, label);
  const matches = steps.filter((s) => s.name.includes(stepNameSubstring));
  assert.equal(
    matches.length,
    1,
    `${label}: job ${JSON.stringify(jobId)} must have EXACTLY ONE step whose name contains ${JSON.stringify(stepNameSubstring)}, found ${matches.length}`,
  );
  const step = matches[0]!;
  return extractEvaluatorFromRun(step.run, label, step.name);
}

const RID = '12345';
const USER_BYPASS = [{ actor_type: 'User', bypass_mode: 'always', actor_id: 12345 }];

/** A well-formed active tag ruleset that varies ONLY its include pattern, so an exit
 *  code reflects the fnmatch COVERAGE decision (not some other misconfiguration). It is an
 *  ACTIVE TAG ruleset (target/enforcement are part of the fetched detail objects) and
 *  restricts every required operation (creation+update+deletion+non_fast_forward) so the
 *  only variable is coverage. `overrides` can retarget/disable it for adversarial tests. */
function ruleset(includePattern: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 1,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: [includePattern], exclude: [] } },
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
    bypass_actors: USER_BYPASS,
    ...overrides,
  };
}

/** Runs an extracted evaluator with the given env + synthetic rulesets; returns exit code. */
function runEvaluator(script: string, env: Record<string, string>, rulesets: unknown[]): number {
  const dir = mkdtempSync(join(tmpdir(), 'fnmatch-'));
  const file = join(dir, 'rulesets.json');
  writeFileSync(file, JSON.stringify(rulesets));
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, RID, RULESETS_FILE: file, ...env },
    encoding: 'utf8',
  });
  assert.equal(res.error, undefined, `evaluator spawn failed: ${res.error}`);
  return res.status ?? -1;
}

// The release-action preflight evaluates BOTH the exact tag and the floating major.
const ACTION_ENV = { EXACT_REF: 'refs/tags/v1.2.3', FLOATING_REF: 'refs/tags/v1' };
// The mcp preflight evaluates the single mcp tag ref it writes.
const MCP_ENV = { TAG_REF: 'refs/tags/mcp-v0.4.0' };

// The job + step that own each evaluator. Extraction is bound to jobs.<job>.steps and the
// named step, so a `node -e` in any other job/step cannot be picked up. (The mcp step name
// says "mcp-v* tag ruleset"; the action step says "v* tag ruleset".)
const ACTION_JOB = 'publish';
const ACTION_STEP = 'verify the v* tag ruleset';
const MCP_JOB = 'github-release';
const MCP_STEP = 'verify the mcp-v* tag ruleset';

test('release-action evaluator: terminal ** (refs/**) does NOT protect a nested tag ref (regression)', () => {
  const script = extractEvaluator('release-action.yml', ACTION_JOB, ACTION_STEP);
  assert.equal(runEvaluator(script, ACTION_ENV, [ruleset('refs/**')]), 1, 'refs/** must be rejected as coverage of refs/tags/v1.2.3');
});

test('release-action evaluator: legitimate patterns still protect the v* refs', () => {
  const script = extractEvaluator('release-action.yml', ACTION_JOB, ACTION_STEP);
  // refs/tags/* covers both refs/tags/v1.2.3 and refs/tags/v1 (each one segment).
  assert.equal(runEvaluator(script, ACTION_ENV, [ruleset('refs/tags/*')]), 0, 'refs/tags/* should cover both v* refs');
  // refs/tags/** (terminal ** == one segment) also covers both.
  assert.equal(runEvaluator(script, ACTION_ENV, [ruleset('refs/tags/**')]), 0, 'refs/tags/** should cover both v* refs');
  // refs/tags/v* covers both.
  assert.equal(runEvaluator(script, ACTION_ENV, [ruleset('refs/tags/v*')]), 0, 'refs/tags/v* should cover both v* refs');
});

test('release-action evaluator: * does not cross a slash (refs/* rejected)', () => {
  const script = extractEvaluator('release-action.yml', ACTION_JOB, ACTION_STEP);
  // refs/* matches only a single segment after refs/, so it does NOT cover refs/tags/v1.
  assert.equal(runEvaluator(script, ACTION_ENV, [ruleset('refs/*')]), 1, 'refs/* must not cover a nested tag ref');
});

test('release-action evaluator: a DISABLED or RETARGETED ruleset does NOT count (detail enforcement + target, pass 40 finding #6)', () => {
  const script = extractEvaluator('release-action.yml', ACTION_JOB, ACTION_STEP);
  // A ruleset that would perfectly cover the refs but is NOT active (enforcement != active)
  // must not be counted — otherwise a disabled ruleset would falsely certify protection.
  assert.equal(
    runEvaluator(script, ACTION_ENV, [ruleset('refs/tags/*', { enforcement: 'disabled' })]),
    1,
    'a disabled (enforcement != active) tag ruleset must not count as coverage',
  );
  assert.equal(
    runEvaluator(script, ACTION_ENV, [ruleset('refs/tags/*', { enforcement: 'evaluate' })]),
    1,
    'an evaluate-mode (non-active) tag ruleset must not count as coverage',
  );
  // A ruleset RETARGETED to branches (target != tag) must not count for a tag ref.
  assert.equal(
    runEvaluator(script, ACTION_ENV, [ruleset('refs/tags/*', { target: 'branch' })]),
    1,
    'a non-tag (retargeted) ruleset must not count as coverage of a tag ref',
  );
  // Sanity: the same pattern as an active tag ruleset DOES cover.
  assert.equal(runEvaluator(script, ACTION_ENV, [ruleset('refs/tags/*')]), 0, 'an active tag ruleset with the same pattern covers');
});

test('mcp evaluator: terminal ** (refs/**) does NOT protect the nested mcp-v* tag (regression)', () => {
  const script = extractEvaluator('release.yml', MCP_JOB, MCP_STEP);
  assert.equal(runEvaluator(script, MCP_ENV, [ruleset('refs/**')]), 1, 'refs/** must be rejected as coverage of refs/tags/mcp-v0.4.0');
});

test('mcp evaluator: legitimate mcp-v* patterns still protect the tag ref', () => {
  const script = extractEvaluator('release.yml', MCP_JOB, MCP_STEP);
  assert.equal(runEvaluator(script, MCP_ENV, [ruleset('refs/tags/mcp-v*')]), 0, 'refs/tags/mcp-v* should cover the mcp tag');
  assert.equal(runEvaluator(script, MCP_ENV, [ruleset('refs/tags/**')]), 0, 'refs/tags/** should cover the mcp tag (one segment)');
});

test('mcp evaluator: a non-tag ~ scope and a v*-only rule do NOT protect the mcp tag', () => {
  const script = extractEvaluator('release.yml', MCP_JOB, MCP_STEP);
  // refs/tags/v* is a different namespace and must not be accepted for mcp-v*.
  assert.equal(runEvaluator(script, MCP_ENV, [ruleset('refs/tags/v*')]), 1, 'refs/tags/v* must not cover refs/tags/mcp-v0.4.0');
});

test('mcp evaluator: a DISABLED or RETARGETED ruleset does NOT count (detail enforcement + target, pass 40 finding #6)', () => {
  const script = extractEvaluator('release.yml', MCP_JOB, MCP_STEP);
  assert.equal(
    runEvaluator(script, MCP_ENV, [ruleset('refs/tags/mcp-v*', { enforcement: 'disabled' })]),
    1,
    'a disabled (enforcement != active) tag ruleset must not count as coverage',
  );
  assert.equal(
    runEvaluator(script, MCP_ENV, [ruleset('refs/tags/mcp-v*', { target: 'branch' })]),
    1,
    'a non-tag (retargeted) ruleset must not count as coverage of the mcp tag',
  );
  assert.equal(runEvaluator(script, MCP_ENV, [ruleset('refs/tags/mcp-v*')]), 0, 'an active tag ruleset with the same pattern covers');
});

// --- non-terminal `**/` recursion (finding: nonterminal ** examples + regression tests
//     are missing) ----------------------------------------------------------------------
// A NON-terminal `**` (from a `**/` in the pattern) IS recursive: it matches ZERO or more
// whole segments. These tests run the SAME matrix against BOTH duplicated evaluators (the
// release-action `v*` preflight and the mcp `mcp-v*` preflight). Each evaluator is driven
// with a single logical ref (the action evaluator checks two refs, so we set both to the
// same value), covering zero-, one-, and multi-segment recursion plus a non-matching leaf.
function bothRefs(ref: string): Record<string, string> {
  return { EXACT_REF: ref, FLOATING_REF: ref };
}

interface EvaluatorUnderTest {
  label: string;
  script: () => string;
  env: (ref: string) => Record<string, string>;
}
const EVALUATORS: EvaluatorUnderTest[] = [
  {
    label: 'release-action v* evaluator',
    script: () => extractEvaluator('release-action.yml', ACTION_JOB, ACTION_STEP),
    env: (ref) => bothRefs(ref),
  },
  {
    label: 'mcp mcp-v* evaluator',
    script: () => extractEvaluator('release.yml', MCP_JOB, MCP_STEP),
    env: (ref) => ({ TAG_REF: ref }),
  },
];

for (const ev of EVALUATORS) {
  test(`${ev.label}: non-terminal **/ matches ZERO intermediate segments (refs/**/leaf vs refs/leaf)`, () => {
    const leaf = 'refs/v1.2.3';
    assert.equal(runEvaluator(ev.script(), ev.env(leaf), [ruleset('refs/**/v1.2.3')]), 0, 'refs/**/v1.2.3 should cover refs/v1.2.3 (zero segments spanned)');
  });

  test(`${ev.label}: non-terminal **/ matches ONE intermediate segment (refs/**/leaf vs refs/tags/leaf)`, () => {
    assert.equal(runEvaluator(ev.script(), ev.env('refs/tags/v1.2.3'), [ruleset('refs/**/v1.2.3')]), 0, 'refs/**/v1.2.3 should cover refs/tags/v1.2.3 (one segment spanned)');
  });

  test(`${ev.label}: non-terminal **/ matches MULTIPLE intermediate segments (refs/**/leaf vs refs/a/b/leaf)`, () => {
    assert.equal(runEvaluator(ev.script(), ev.env('refs/a/b/v1.2.3'), [ruleset('refs/**/v1.2.3')]), 0, 'refs/**/v1.2.3 should cover refs/a/b/v1.2.3 (multiple segments spanned)');
  });

  test(`${ev.label}: non-terminal **/ still requires the trailing leaf to match (refs/**/v1.2.3 vs .../v1.2.4)`, () => {
    assert.equal(runEvaluator(ev.script(), ev.env('refs/tags/v1.2.4'), [ruleset('refs/**/v1.2.3')]), 1, 'refs/**/v1.2.3 must NOT cover refs/tags/v1.2.4 (leaf differs)');
  });

  test(`${ev.label}: a mid-pattern **/ spans segments but * stays within one (refs/tags/**/v* )`, () => {
    // refs/tags/**/v* : **/ spans "a", then v* matches the final segment v1.
    assert.equal(runEvaluator(ev.script(), ev.env('refs/tags/a/v1'), [ruleset('refs/tags/**/v*')]), 0, 'refs/tags/**/v* should cover refs/tags/a/v1');
    // The terminal v* cannot itself cross a slash, so refs/tags/a/b (no v-leaf) is not covered.
    assert.equal(runEvaluator(ev.script(), ev.env('refs/tags/a/b'), [ruleset('refs/tags/**/v*')]), 1, 'refs/tags/**/v* must not cover refs/tags/a/b');
  });

  test(`${ev.label}: Ruby range rule — a hyphen before ] is a LITERAL, not a range operator`, () => {
    const s = ev.script();
    // [v-] : Ruby range rule — "-" is a range op only when the char AFTER it is not "]".
    // Here "-" is the last member, so the set is {v, -}; a "v"-prefixed tag IS covered.
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[v-]1.2.3')]), 0,
      '[v-] is the literal set {v,-} (trailing hyphen), so it covers a v-prefixed tag');
    // ...and it does NOT cover a char between v and something (no range formed): "w" not in {v,-}.
    assert.equal(runEvaluator(s, ev.env('refs/tags/w1.2.3'), [ruleset('refs/tags/[v-]1.2.3')]), 1,
      '[v-] forms NO range, so it does not cover a w-prefixed tag');
    // A genuine range [t-x] DOES cover "v" (t <= v <= x) but not "a".
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[t-x]1.2.3')]), 0,
      '[t-x] is a real range covering v');
    assert.equal(runEvaluator(s, ev.env('refs/tags/a1.2.3'), [ruleset('refs/tags/[t-x]1.2.3')]), 1,
      '[t-x] does not cover a (outside t..x)');
    // A leading hyphen [-v] is also literal {-, v} (no left bound), covering a v-prefixed tag.
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[-v]1.2.3')]), 0,
      '[-v] is the literal set {-,v} (leading hyphen), so it covers a v-prefixed tag');
  });

  test(`${ev.label}: GitHub subset — [!] empty-set negation supported; leading ] closes empty set`, () => {
    const s = ev.script();
    // [!] is a negated EMPTY set (leading ] closes it) = ANY single non-/ char; covers v.
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[!]1.2.3')]), 0,
      '[!] is a negated empty set = any single char, so it covers a v-prefixed tag');
    // Positive empty set [] matches NOTHING.
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[]v1.2.3')]), 1,
      '[] is an empty set that matches nothing');
    // A leading (unescaped) ] closes an empty set, so []v] = empty-set + literal "v]" => no match.
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[]v]1.2.3')]), 1,
      'a leading ] closes an EMPTY set (not a literal member), so []v] matches nothing');
    // A NEGATED real set [!a-c] matches any char NOT in a..c: covers v, not b.
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[!a-c]1.2.3')]), 0,
      '[!a-c] matches a char outside a..c (covers v)');
    assert.equal(runEvaluator(s, ev.env('refs/tags/b1.2.3'), [ruleset('refs/tags/[!a-c]1.2.3')]), 1,
      '[!a-c] does not match a char inside a..c (b)');
  });

  test(`${ev.label}: an UNTERMINATED character class matches NOTHING (Ruby), not a literal [`, () => {
    const s = ev.script();
    // Finding: Ruby returns NO match for an unterminated `[`, even against a ref that
    // literally contains the same text — so it must NOT be counted as covering ANY ref.
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[v1.2.3')]), 1,
      'an unterminated [ matches nothing; it does not cover a v-prefixed tag');
    assert.equal(runEvaluator(s, ev.env('refs/tags/[v1.2.3'), [ruleset('refs/tags/[v1.2.3')]), 1,
      'an unterminated [ matches nothing even against a literally-equal ref (Ruby)');
    assert.equal(runEvaluator(s, ev.env('refs/x/y'), [ruleset('refs/[ab/cd')]), 1,
      'an unterminated [ spanning a / still matches nothing');
  });

  test(`${ev.label}: FAILS CLOSED on unsupported ruleset syntax (backslash escapes, [^] negation)`, () => {
    const s = ev.script();
    // GitHub rulesets do NOT support backslash escaping — a pattern containing `\` must
    // make the preflight FAIL CLOSED (nonzero exit), not be interpreted our way.
    assert.notEqual(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/v\\.1.2.3')]), 0,
      'a backslash escape in a ruleset pattern must fail the preflight closed');
    assert.notEqual(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs\\/tags/v1.2.3')]), 0,
      'a backslash-escaped slash must fail the preflight closed');
    // GitHub rulesets do NOT support `[^...]` negation (only `[!...]`) — fail closed.
    assert.notEqual(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/[^a-c]1.2.3')]), 0,
      'a [^...] class negation must fail the preflight closed');
    // Even a well-formed OTHER ruleset cannot rescue: an unsupported pattern ANYWHERE in the
    // evaluated set fails closed (a supported pattern alone still works — sanity below).
    assert.equal(runEvaluator(s, ev.env('refs/tags/v1.2.3'), [ruleset('refs/tags/v*')]), 0,
      'sanity: a supported pattern still yields coverage');
  });
}

// --- namespace-wide coverage (pass 42 finding #4) ----------------------------------------
// The per-ref checks prove the CONCRETE refs a run writes are locked; the NAMESPACE check
// additionally requires an active tag ruleset whose include COVERS the whole
// refs/tags/<prefix>* namespace, so a finite LIST of exact tags (which would pass every
// concrete probe) cannot leave FUTURE tags in the namespace unprotected. The committed
// The committed invocation ALWAYS sets NAMESPACE_PREFIX (asserted below), so this runs at
// release time. (readFileSync / fileURLToPath / WORKFLOWS are imported/defined above.)

/** An active tag ruleset with an explicit include LIST (covers those exact refs, restricts
 *  every op, grants only the release identity) — used to prove a finite list passes the
 *  per-ref probes but FAILS namespace coverage. */
function listRuleset(includes: string[]): unknown {
  return ruleset(includes[0]!, { conditions: { ref_name: { include: includes, exclude: [] } } });
}

test('release-action namespace: a finite exact-tag LIST passes the per-ref probes but FAILS namespace coverage (finding #4)', () => {
  const script = extractEvaluator('release-action.yml', ACTION_JOB, ACTION_STEP);
  const list = [listRuleset(['refs/tags/v1.2.3', 'refs/tags/v1'])];
  // Without NAMESPACE_PREFIX the finite list covers both concrete refs -> passes.
  assert.equal(runEvaluator(script, ACTION_ENV, list), 0, 'the finite list covers the concrete refs (per-ref pass)');
  // WITH the namespace prefix the finite list no longer suffices — future v* tags are unprotected.
  assert.equal(runEvaluator(script, { ...ACTION_ENV, NAMESPACE_PREFIX: 'v' }, list), 1,
    'a finite exact-tag list does not cover the whole refs/tags/v* namespace');
});

test('release-action namespace: a covering refs/tags/v* ruleset satisfies namespace coverage (finding #4)', () => {
  const script = extractEvaluator('release-action.yml', ACTION_JOB, ACTION_STEP);
  assert.equal(runEvaluator(script, { ...ACTION_ENV, NAMESPACE_PREFIX: 'v' }, [ruleset('refs/tags/v*')]), 0,
    'refs/tags/v* covers the entire v* namespace');
  // An EXCLUDE could carve a hole, so a covering include WITH an exclude fails namespace coverage.
  const withExclude = ruleset('refs/tags/v*', { conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v9'] } } });
  assert.equal(runEvaluator(script, { ...ACTION_ENV, NAMESPACE_PREFIX: 'v' }, [withExclude]), 1,
    'a namespace-covering include with any exclude cannot be relied on for full coverage');
});

test('mcp namespace: a finite exact-tag LIST fails namespace coverage; refs/tags/mcp-v* satisfies it (finding #4)', () => {
  const script = extractEvaluator('release.yml', MCP_JOB, MCP_STEP);
  const list = [listRuleset(['refs/tags/mcp-v0.4.0'])];
  assert.equal(runEvaluator(script, MCP_ENV, list), 0, 'the finite list covers the concrete mcp ref (per-ref pass)');
  assert.equal(runEvaluator(script, { ...MCP_ENV, NAMESPACE_PREFIX: 'mcp-v' }, list), 1,
    'a finite exact mcp tag does not cover the whole refs/tags/mcp-v* namespace');
  assert.equal(runEvaluator(script, { ...MCP_ENV, NAMESPACE_PREFIX: 'mcp-v' }, [ruleset('refs/tags/mcp-v*')]), 0,
    'refs/tags/mcp-v* covers the entire mcp-v* namespace');
  // A broader v* ruleset does NOT cover the mcp-v* namespace (mcp tags start with "m", not "v").
  assert.equal(runEvaluator(script, { ...MCP_ENV, NAMESPACE_PREFIX: 'mcp-v' }, [ruleset('refs/tags/v*')]), 1,
    'refs/tags/v* does not cover the mcp-v* namespace');
});

test('both release evaluators HARDCODE NAMESPACE_PREFIX in the committed invocation (non-removable gate, finding #4)', () => {
  const action = readFileSync(fileURLToPath(new URL('release-action.yml', WORKFLOWS)), 'utf8');
  assert.match(action, /NAMESPACE_PREFIX="v" \\\r?\n\s*node -e '/, 'release-action sets NAMESPACE_PREFIX="v" on the evaluator invocation');
  const mcp = readFileSync(fileURLToPath(new URL('release.yml', WORKFLOWS)), 'utf8');
  assert.match(mcp, /NAMESPACE_PREFIX="mcp-v" \\\r?\n\s*node -e '/, 'release.yml sets NAMESPACE_PREFIX="mcp-v" on the evaluator invocation');
});

test('release-action namespace: a PARTIAL restricting layer with a FOREIGN bypass is NOT ignored (pass 43 finding #4)', () => {
  const script = extractEvaluator('release-action.yml', ACTION_JOB, ACTION_STEP);
  // A whole-namespace covering ruleset (id 1) + a partial layer over refs/tags/v1* (id 2) that
  // grants a FOREIGN bypass. Both concrete refs (v1.2.3, v1) are covered by BOTH, so the per-ref
  // check would already flag id 2 for THOSE refs — use a partial pattern (v9*) that does NOT
  // match the probe refs so ONLY the namespace overlap audit can catch it.
  const covering = ruleset('refs/tags/v*');
  const partialForeign = {
    id: 2,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v9*'], exclude: [] } },
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
    bypass_actors: [...USER_BYPASS, { actor_type: 'Team', bypass_mode: 'always', actor_id: 99 }],
  };
  // The concrete refs are v1.2.3/v1 — id 2 (v9*) does NOT apply to them, so a per-ref-only check
  // passes; the namespace overlap audit must FAIL because id 2 opens a v9* hole.
  assert.equal(runEvaluator(script, { ...ACTION_ENV, NAMESPACE_PREFIX: 'v' }, [covering, partialForeign]), 1,
    'a partial restricting layer (v9*) with a foreign bypass fails the namespace audit');
  // A DISJOINT partial layer (mcp-v9*) with a foreign bypass must NOT affect the v namespace.
  const disjoint = { ...partialForeign, id: 3, conditions: { ref_name: { include: ['refs/tags/mcp-v9*'], exclude: [] } } };
  assert.equal(runEvaluator(script, { ...ACTION_ENV, NAMESPACE_PREFIX: 'v' }, [covering, disjoint]), 0,
    'a disjoint (mcp-v9*) partial layer does not affect the v namespace');
});


// char-level port of Ruby's dir.c fnmatch/bracket algorithm (not the evaluator's segment
// model), used as an ORACLE to cross-check BOTH committed evaluators over SUPPORTED syntax.
// It encodes: a REVERSED range matches its two endpoints; a `/` never matches a bracket
// (FNM_PATHNAME); an UNTERMINATED `[` matches NOTHING (Ruby returns no match); a leading
// `]` closes an EMPTY set; `[!...]` negation; `**/` recursive vs terminal `**` == `*`.
// Backslash escaping and `[^...]` negation are UNSUPPORTED by GitHub rulesets and are NOT
// modelled here (the evaluators FAIL CLOSED on them — covered by a dedicated test).
const ORACLE_UNTERMINATED = Symbol('unterminated');
function rubyFnmatchPathname(pat: string, str: string): boolean {
  // Returns [matched, indexPast] for a bracket at pat[pi], or ORACLE_UNTERMINATED.
  function bracket(pi: number, ch: string): [boolean, number] | typeof ORACLE_UNTERMINATED {
    let i = pi + 1;
    let neg = false;
    if (pat[i] === '!') { neg = true; i++; } // GitHub subset: only `!` negation
    if (pat[i] === ']') { // leading `]` closes an EMPTY set
      const end = i + 1;
      return [neg ? ch !== '/' : false, end];
    }
    let matched = false;
    while (i < pat.length && pat[i] !== ']') {
      const lo = pat[i]!; i += 1; // no backslash escaping in the supported subset
      if (pat[i] === '-' && i + 1 < pat.length && pat[i + 1] !== ']') {
        i += 1;
        const hi = pat[i]!; i += 1;
        // Ruby dir.c: each range bound is FIRST tested by a literal byte-compare (so both
        // endpoints match even for a REVERSED range lo>hi), then the codepoint interval is
        // tested only when lo<=hi. So `[z-a]` matches EXACTLY {z,a}; `[a-z]` matches a..z.
        if (ch === lo || ch === hi) matched = true;
        else if (lo.charCodeAt(0) <= hi.charCodeAt(0)
          && ch.charCodeAt(0) >= lo.charCodeAt(0) && ch.charCodeAt(0) <= hi.charCodeAt(0)) matched = true;
      } else if (ch === lo) { matched = true; }
    }
    if (i >= pat.length) return ORACLE_UNTERMINATED; // unterminated `[` -> NO MATCH (Ruby)
    const end = i + 1;
    if (ch === '/') return [false, end]; // FNM_PATHNAME: bracket never matches `/`
    return [neg ? !matched : matched, end];
  }
  function helper(pi: number, si: number): boolean {
    while (pi < pat.length) {
      const pc = pat[pi]!;
      if (pc === '*') {
        let stars = 0;
        while (pat[pi] === '*') { stars++; pi++; }
        if (stars >= 2 && pi < pat.length && pat[pi] === '/') {
          // `**/` : match zero or more WHOLE segments, then the remainder.
          const after = pi + 1;
          if (helper(after, si)) return true;
          for (let k = si; k < str.length; k++) {
            if (str[k] === '/' && helper(after, k + 1)) return true;
          }
          return false;
        }
        // `*` or a terminal `**` : match zero or more NON-`/` chars, then the remainder.
        for (let k = si; ; k++) {
          if (helper(pi, k)) return true;
          if (k < str.length && str[k] !== '/') continue;
          return false;
        }
      } else if (pc === '?') {
        if (si >= str.length || str[si] === '/') return false;
        pi++; si++;
      } else if (pc === '[') {
        if (si >= str.length) return false;
        const r = bracket(pi, str[si]!);
        if (r === ORACLE_UNTERMINATED) return false; // unterminated class -> NO MATCH (Ruby)
        if (!r[0]) return false;
        pi = r[1]; si++;
      } else {
        // No backslash escaping in the supported subset: every other char is a literal
        // (a `\` would be an unsupported pattern and is not passed to the oracle).
        if (si >= str.length || str[si] !== pc) return false;
        pi++; si++;
      }
    }
    return si === str.length;
  }
  return helper(0, 0);
}

// A broad matrix of tricky (pattern, ref) pairs — all using SUPPORTED GitHub-ruleset
// syntax (NO backslash escaping, NO `[^...]` negation; those are covered by the dedicated
// fail-closed test) — exercising reversed ranges, slashes inside classes, unterminated
// classes (no match), empty/negated-empty sets, ranges, wildcards, and `**/`. Expected
// results come from the independent Ruby oracle above.
const ORACLE_MATRIX: Array<[string, string]> = [
  // reversed range -> matches EXACTLY its two endpoints {lo,hi} (Ruby), nothing between
  ['refs/tags/[z-a]1.2.3', 'refs/tags/v1.2.3'],
  ['refs/tags/[z-a]1.2.3', 'refs/tags/z1.2.3'],
  ['refs/tags/[z-a]1.2.3', 'refs/tags/a1.2.3'],
  ['refs/tags/[z-a]1.2.3', 'refs/tags/m1.2.3'],
  // reversed range endpoints inside a bigger class stay matchable
  ['refs/tags/[q-n5]1.2.3', 'refs/tags/q1.2.3'],
  ['refs/tags/[q-n5]1.2.3', 'refs/tags/n1.2.3'],
  ['refs/tags/[q-n5]1.2.3', 'refs/tags/51.2.3'],
  ['refs/tags/[q-n5]1.2.3', 'refs/tags/o1.2.3'],
  // forward range
  ['refs/tags/[t-x]1.2.3', 'refs/tags/v1.2.3'],
  ['refs/tags/[t-x]1.2.3', 'refs/tags/a1.2.3'],
  ['refs/tags/[t-x]1.2.3', 'refs/tags/t1.2.3'],
  ['refs/tags/[t-x]1.2.3', 'refs/tags/x1.2.3'],
  // trailing / leading hyphen literals
  ['refs/tags/[v-]1.2.3', 'refs/tags/v1.2.3'],
  ['refs/tags/[-v]1.2.3', 'refs/tags/-1.2.3'],
  // slash inside class (class-aware segmentation): the `/` member is inert
  ['refs/tags/[a/]', 'refs/tags/a'],
  ['refs/tags/[a/]', 'refs/tags/b'],
  ['refs/[x/]tags', 'refs/xtags'],
  // UNTERMINATED class -> NO MATCH (Ruby), even against a literally-equal ref
  ['refs/tags/[v1.2.3', 'refs/tags/[v1.2.3'],
  ['refs/tags/[v1.2.3', 'refs/tags/v1.2.3'],
  ['refs/[ab/cd', 'refs/[ab/cd'],
  ['refs/[ab/cd', 'refs/[ab/ce'],
  // empty / negated-empty sets (only `!` negation is supported)
  ['refs/tags/[]v1.2.3', 'refs/tags/v1.2.3'],
  ['refs/tags/[!]1.2.3', 'refs/tags/v1.2.3'],
  ['refs/tags/[]v]1.2.3', 'refs/tags/v1.2.3'],
  // negation with a real set
  ['refs/tags/[!a-c]1.2.3', 'refs/tags/v1.2.3'],
  ['refs/tags/[!a-c]1.2.3', 'refs/tags/b1.2.3'],
  // wildcards under FNM_PATHNAME
  ['refs/tags/v*', 'refs/tags/v1.2.3'],
  ['refs/tags/v*', 'refs/tags/v1/2'],
  ['refs/*', 'refs/tags/x'],
  ['refs/tags/v?.2.3', 'refs/tags/v1.2.3'],
  ['refs/tags/v?.2.3', 'refs/tags/v12.2.3'],
  // `**/` recursion vs terminal `**`
  ['refs/**/v1.2.3', 'refs/v1.2.3'],
  ['refs/**/v1.2.3', 'refs/a/b/v1.2.3'],
  ['refs/**', 'refs/tags/v1.2.3'],
  ['refs/tags/**', 'refs/tags/v1.2.3'],
];

for (const ev of EVALUATORS) {
  test(`${ev.label}: matches the independent Ruby File.fnmatch oracle across the tricky matrix`, () => {
    const s = ev.script();
    for (const [pattern, ref] of ORACLE_MATRIX) {
      const expected = rubyFnmatchPathname(pattern, ref);
      const covered = runEvaluator(s, ev.env(ref), [ruleset(pattern)]) === 0;
      assert.equal(
        covered,
        expected,
        `pattern ${JSON.stringify(pattern)} vs ref ${JSON.stringify(ref)}: evaluator covered=${covered}, Ruby oracle=${expected}`,
      );
    }
  });
}

// Self-check: the oracle itself encodes the SUPPORTED-subset behaviors (guards against an
// oracle that merely echoes the evaluator — these are asserted against Ruby's rules).
test('oracle: Ruby fnmatch reversed range / slash-in-class / unterminated-class (no match) semantics', () => {
  // Reversed range matches EXACTLY its two endpoints (Ruby dir.c byte-compares each bound).
  assert.equal(rubyFnmatchPathname('[z-a]', 'v'), false, 'reversed range does not match an interior char');
  assert.equal(rubyFnmatchPathname('[z-a]', 'z'), true, 'reversed range matches its low endpoint');
  assert.equal(rubyFnmatchPathname('[z-a]', 'a'), true, 'reversed range matches its high endpoint');
  assert.equal(rubyFnmatchPathname('[z-a]', 'm'), false, 'reversed range matches nothing between the endpoints');
  assert.equal(rubyFnmatchPathname('[t-x]', 'v'), true, 'forward range matches within bounds');
  assert.equal(rubyFnmatchPathname('[t-x]', 't'), true, 'forward range includes its low endpoint');
  assert.equal(rubyFnmatchPathname('[t-x]', 'x'), true, 'forward range includes its high endpoint');
  assert.equal(rubyFnmatchPathname('a[/]b', 'a/b'), false, 'a bracket never matches `/` (FNM_PATHNAME)');
  assert.equal(rubyFnmatchPathname('[a/]', 'a'), true, 'a non-slash member of a slash-containing class still matches');
  // UNTERMINATED class -> NO MATCH (Ruby), even against a literally-equal string.
  assert.equal(rubyFnmatchPathname('[abc', '[abc'), false, 'unterminated `[` matches nothing (not a literal)');
  assert.equal(rubyFnmatchPathname('[abc', 'a'), false, 'unterminated `[` does not act as a class');
  assert.equal(rubyFnmatchPathname('[]', 'a'), false, 'positive empty set matches nothing');
  assert.equal(rubyFnmatchPathname('[!]', 'a'), true, 'negated empty set matches any non-slash char');
  assert.equal(rubyFnmatchPathname('[!]', '/'), false, 'negated empty set still does not match `/`');
});

// --- extractor integrity -------------------------------------------------------------
// These synthetic tests build a full `jobs.<job>.steps` document and assert the parser is
// JOB-SCOPED, captures only a DIRECT run: scalar (never a nested with.run), handles block-
// scalar headers, rejects trailing commands after the evaluator closer, and rejects
// premature/decoy closers, inline apostrophes, duplicate/absent openers, and wrong steps.

interface SynthStep { name: string; run?: string[]; body?: string[]; }

/** Builds a full workflow document `jobs.<jobId>.steps:` from synthetic steps. A step's
 *  `run` is emitted as a `run: |` block scalar; `body` lines are emitted verbatim at the
 *  step-key indent (8 spaces) + any leading spaces in the string, for nested structures. */
function buildJob(steps: SynthStep[], jobId = 'target-job'): string {
  const out: string[] = ['jobs:', `  ${jobId}:`, '    runs-on: ubuntu-latest', '    steps:'];
  for (const s of steps) {
    out.push(`      - name: ${s.name}`);
    if (s.run) {
      out.push('        run: |');
      for (const l of s.run) out.push(`          ${l}`);
    }
    for (const l of s.body ?? []) out.push(`        ${l}`);
  }
  return out.join('\n') + '\n';
}

/** A step whose run block wraps the given JS body lines in a `node -e '...'` evaluator. */
function evalStep(name: string, jsLines: string[]): SynthStep {
  return { name, run: ['set -euo pipefail', 'FOO="bar" \\', "node -e '", ...jsLines, "'"] };
}

/** Convenience: parse the single named step's evaluator from a synthetic single-job doc. */
function extractSynthetic(steps: SynthStep[], stepName: string): string {
  return parseEvaluatorFromStep(buildJob(steps), 'target-job', stepName, 'synthetic');
}

test('extractor: a clean multi-line evaluator is extracted in full', () => {
  const script = extractSynthetic(
    [
      evalStep('the target preflight', ['const fs = require("fs");', 'console.log("ok");', 'process.exit(0);']),
      { name: 'next', run: ['echo done'] },
    ],
    'the target preflight',
  );
  assert.ok(script.includes('console.log("ok")'), 'full body should be extracted');
  assert.ok(!script.includes("'"), 'clean body has no single quote');
});

test('extractor: an apostrophe injected into the evaluator body is REJECTED (not truncated)', () => {
  assert.throws(
    () => extractSynthetic(
      [
        evalStep('the target preflight', ['const fs = require("fs");', "// don't trust unverified input", 'console.log("still here");']),
        { name: 'next', run: ['echo done'] },
      ],
      'the target preflight',
    ),
    /closer is not a lone quote/,
    'an inline apostrophe makes the first quote-bearing line a non-lone closer and must be rejected',
  );
});

test('extractor: an unterminated evaluator (no closing quote in the run scalar) is REJECTED', () => {
  assert.throws(
    () => extractSynthetic(
      [
        { name: 'the target preflight', run: ['set -euo pipefail', "node -e '", 'const fs = require("fs");', 'console.log("no closer");'] },
        { name: 'next', run: ['echo done'] },
      ],
      'the target preflight',
    ),
    /unterminated/,
    'a missing closing quote must fail extraction',
  );
});

test('extractor: an evaluator in a DIFFERENT step is not picked up (scoped to the named step)', () => {
  assert.throws(
    () => extractSynthetic(
      [
        evalStep('some other step', ['console.log("other");', 'process.exit(0);']),
        { name: 'the target preflight', run: ['echo "no evaluator here"'] },
      ],
      'the target preflight',
    ),
    /anchored .* opener line, found 0/,
    'a node -e in a different step must not be extracted for the target step',
  );
});

test('extractor: a step in a DIFFERENT job is not picked up (scoped to jobs.<job>.steps)', () => {
  // Two jobs; only job "other-job" carries the target-named step. Parsing "target-job"
  // must not reach across jobs to find it.
  const doc = [
    'jobs:',
    '  target-job:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: unrelated',
    '        run: echo hi',
    '  other-job:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: the target preflight',
    '        run: |',
    "          node -e '",
    '          console.log("wrong job");',
    "          '",
  ].join('\n') + '\n';
  assert.throws(
    () => parseEvaluatorFromStep(doc, 'target-job', 'the target preflight', 'synthetic'),
    /must have EXACTLY ONE step whose name contains .* found 0/,
    'a step in another job must not be selected',
  );
  // And parsing the CORRECT job finds it.
  const script = parseEvaluatorFromStep(doc, 'other-job', 'the target preflight', 'synthetic');
  assert.ok(script.includes('console.log("wrong job")'), 'the step in the named job is extracted');
});

test('extractor: a nested with.run is NOT treated as the step run (only a DIRECT run scalar)', () => {
  // The step uses an action and carries a nested `with.run`; it has NO direct run scalar,
  // so extraction must fail rather than pull the evaluator out of with.run.
  const doc = buildJob([
    {
      name: 'the target preflight',
      body: [
        'uses: some/action@0000000000000000000000000000000000000000',
        'with:',
        '  run: |',
        "    node -e '",
        '    console.log("nested with.run");',
        "    '",
      ],
    },
    { name: 'next', run: ['echo done'] },
  ]);
  assert.throws(
    () => parseEvaluatorFromStep(doc, 'target-job', 'the target preflight', 'synthetic'),
    /has no direct run: scalar/,
    'a nested with.run must not be accepted as the step run',
  );
});

test('extractor: a block-scalar header with a chomping indicator (run: |-) is parsed', () => {
  const doc = buildJob([
    {
      name: 'the target preflight',
      body: ['run: |-', "  node -e '", '  console.log("chomped block");', "  '"],
    },
    { name: 'next', run: ['echo done'] },
  ]);
  const script = parseEvaluatorFromStep(doc, 'target-job', 'the target preflight', 'synthetic');
  assert.ok(script.includes('console.log("chomped block")'), 'a |- block scalar must be parsed like |');
});

// --- conforming YAML block-scalar semantics (finding: use conforming scalar parsing) ----
test('scalar: parseBlockHeader recognizes style, chomping, and indentation indicators (either order)', () => {
  assert.deepEqual(parseBlockHeader('|'), { style: '|', chomp: '', indent: 0 });
  assert.deepEqual(parseBlockHeader('>'), { style: '>', chomp: '', indent: 0 });
  assert.deepEqual(parseBlockHeader('|-'), { style: '|', chomp: '-', indent: 0 });
  assert.deepEqual(parseBlockHeader('|+'), { style: '|', chomp: '+', indent: 0 });
  assert.deepEqual(parseBlockHeader('|2'), { style: '|', chomp: '', indent: 2 });
  assert.deepEqual(parseBlockHeader('|2-'), { style: '|', chomp: '-', indent: 2 });
  assert.deepEqual(parseBlockHeader('|-2'), { style: '|', chomp: '-', indent: 2 });
  assert.deepEqual(parseBlockHeader('>+3'), { style: '>', chomp: '+', indent: 3 });
  // Non-headers (inline scalars) return null.
  assert.equal(parseBlockHeader('echo hi'), null);
  assert.equal(parseBlockHeader('"quoted"'), null);
  assert.equal(parseBlockHeader('|junk'), null);
  assert.equal(parseBlockHeader('|-+'), null, 'two chomping indicators are not a valid header');
});

test('scalar: chomping — strip (-) drops the trailing newline, clip keeps one, keep (+) keeps all', () => {
  // Two content lines + exactly ONE trailing blank line, bounded by a sibling step so the
  // block's trailing blank is unambiguous.
  const mk = (h: string) => {
    const doc = [
      'jobs:', '  j:', '    steps:',
      '      - name: s',
      `        run: ${h}`,
      '          alpha',
      '          beta',
      '',
      '      - name: t',
      '        run: echo done',
    ].join('\n') + '\n';
    return parseJobSteps(doc, 'j', 'synthetic')[0]!.run;
  };
  assert.equal(mk('|-'), 'alpha\nbeta', 'strip: no trailing newline, trailing blank dropped');
  assert.equal(mk('|'), 'alpha\nbeta\n', 'clip: exactly one trailing newline');
  assert.equal(mk('|+'), 'alpha\nbeta\n\n', 'keep: final newline + one per trailing blank line');
});

test('scalar: explicit indentation indicator sets the content indent (run: |2)', () => {
  // With `|2`, content indent = keyIndent(8) + 2 = 10; deeper indentation is preserved.
  const doc = [
    'jobs:', '  j:', '    steps:',
    '      - name: s',
    '        run: |2',
    '          alpha',      // 10 spaces -> dedented to "alpha"
    '            indented', // 12 spaces -> dedented to "  indented"
  ].join('\n') + '\n';
  assert.equal(parseJobSteps(doc, 'j', 'synthetic')[0]!.run, 'alpha\n  indented\n');
});

test('scalar: folded (>) joins wrapped lines with spaces and keeps blank-line breaks', () => {
  const doc = [
    'jobs:', '  j:', '    steps:',
    '      - name: s',
    '        run: >',
    '          one two',
    '          three',
    '',
    '          four',
  ].join('\n') + '\n';
  // "one two" + fold(space) + "three", blank line -> newline, then "four".
  assert.equal(parseJobSteps(doc, 'j', 'synthetic')[0]!.run, 'one two three\nfour\n');
});

test('extractor: two evaluators in the SAME target step are REJECTED as ambiguous (duplicate opener)', () => {
  assert.throws(
    () => extractSynthetic(
      [
        {
          name: 'the target preflight',
          run: ["node -e '", 'console.log("first");', "'", "node -e '", 'console.log("second");', "'"],
        },
        { name: 'next', run: ['echo done'] },
      ],
      'the target preflight',
    ),
    /EXACTLY ONE anchored .* opener line, found 2/,
    'a duplicate opener within the target step must be rejected as ambiguous',
  );
});

test('extractor: a premature/decoy lone-quote closer is REJECTED (trailing commands after the closer)', () => {
  // A lone-quote line appears BEFORE the real closer. The FIRST quote closes the POSIX
  // string, so the remaining real body becomes TRAILING commands and is rejected.
  assert.throws(
    () => extractSynthetic(
      [
        {
          name: 'the target preflight',
          run: ["node -e '", 'console.log("before decoy");', "'", 'console.log("after decoy");', "'"],
        },
        { name: 'next', run: ['echo done'] },
      ],
      'the target preflight',
    ),
    /trailing command after the evaluator closer/,
    'a premature closer leaves trailing commands and must be rejected',
  );
});

test('extractor: a command AFTER the evaluator closer is REJECTED (evaluator must be terminal)', () => {
  assert.throws(
    () => extractSynthetic(
      [
        {
          name: 'the target preflight',
          run: ["node -e '", 'console.log("body");', "'", 'echo "post-evaluator command"'],
        },
        { name: 'next', run: ['echo done'] },
      ],
      'the target preflight',
    ),
    /trailing command after the evaluator closer/,
    'a trailing command after the closer could mask the evaluator exit status and must be rejected',
  );
});

test('extractor: a `# node -e ...` shell-comment decoy is not mistaken for the opener (anchored)', () => {
  const script = extractSynthetic(
    [
      {
        name: 'the target preflight',
        run: ['# node -e (decoy comment, not the opener)', 'echo prep', "node -e '", 'console.log("real body");', "'"],
      },
      { name: 'next', run: ['echo done'] },
    ],
    'the target preflight',
  );
  assert.ok(script.includes('console.log("real body")'), 'the real anchored opener body should be extracted');
});

test('extractor: a `- name:` / `node -e` inside ANOTHER block scalar is not mistaken for structure', () => {
  const script = extractSynthetic(
    [
      { name: 'decoy carrier', run: ['echo "- name: fake step"', "echo \"node -e '\"", 'echo tail'] },
      evalStep('the target preflight', ['console.log("real target");', 'process.exit(0);']),
    ],
    'the target preflight',
  );
  assert.ok(script.includes('console.log("real target")'), 'block-scalar decoys must not shadow the real target step');
});

test('extractor: a FAKE jobs mapping inside a run scalar does NOT shadow the real workflow', () => {
  // The first step's run block embeds a complete fake `jobs:` doc (with the target step +
  // an evaluator). Because the document-level scan skips block scalars, only the REAL
  // top-level jobs mapping is used, so the fake one cannot shadow it.
  const doc = [
    'jobs:',
    '  target-job:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: decoy carrier',
    '        run: |',
    '          cat <<YAML',
    '          jobs:',
    '            evil:',
    '              steps:',
    '                - name: the target preflight',
    "                  run: node -e 'console.log(1)'",
    '          YAML',
    '      - name: the target preflight',
    '        run: |',
    "          node -e '",
    '          console.log("REAL body");',
    "          '",
  ].join('\n') + '\n';
  const script = parseEvaluatorFromStep(doc, 'target-job', 'the target preflight', 'synthetic');
  assert.ok(script.includes('console.log("REAL body")'), 'the real top-level jobs mapping must be used, not the scalar-embedded fake');
});

test('extractor: TWO top-level jobs mappings (duplicate key) are REJECTED', () => {
  const doc = [
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: x',
    '        run: echo x',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: the target preflight',
    '        run: |',
    "          node -e '",
    '          console.log("dup");',
    "          '",
  ].join('\n') + '\n';
  assert.throws(
    () => parseEvaluatorFromStep(doc, 'b', 'the target preflight', 'synthetic'),
    /expected EXACTLY ONE top-level 'jobs:' mapping, found 2/,
    'a duplicate top-level jobs mapping must be rejected',
  );
});

test('extractor: a step name matching MORE THAN ONE step is REJECTED', () => {
  assert.throws(
    () => extractSynthetic(
      [
        evalStep('duplicate preflight', ['console.log("a");']),
        evalStep('duplicate preflight', ['console.log("b");']),
      ],
      'duplicate preflight',
    ),
    /must have EXACTLY ONE step whose name contains/,
    'an ambiguous step-name match must be rejected',
  );
});

test('extractor: an absent step name is REJECTED', () => {
  assert.throws(
    () => extractSynthetic([evalStep('the target preflight', ['console.log("a");'])], 'no such step'),
    /must have EXACTLY ONE step whose name contains/,
    'a step name that matches no step must be rejected',
  );
});

test('extractor: both committed workflow evaluators extract cleanly from their preflight steps (no stray single quote)', () => {
  for (const [wf, job, step] of [['release.yml', MCP_JOB, MCP_STEP], ['release-action.yml', ACTION_JOB, ACTION_STEP]] as const) {
    const script = extractEvaluator(wf, job, step);
    assert.ok(script.length > 200, `${wf}: extracted evaluator should be the full multi-line body`);
    assert.ok(!script.includes("'"), `${wf}: committed evaluator body must contain no single quote`);
  }
});
