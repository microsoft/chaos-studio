import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Machine-checkable evidence for the OneBranch Official pipeline's Real-SignType requirement
// (pass 42 finding #2, hardened pass 43 finding #6, pass 44 finding #9). The AUTHORITATIVE
// prevention of feature-branch signing is external — the ESRP `external_distribution` (Real)
// SignType entitlement (portal-confirmed, not REST-queryable) plus the signing ENVIRONMENT's
// Branch Control check (verified live by scripts/verify-ado-signing-protections.sh). These tests
// do NOT re-prove those live controls; they LOCK the committed, reviewed pipeline so a PR cannot
// silently REMOVE the Real-SignType request or the fail-closed CodeSign Validation gates that
// discriminate a Real signature from a Test one.
//
// The pipeline is parsed into an ORDERED TASK STRUCTURE (per stage, each task's id + inputs) with
// a small indentation-aware YAML-subset parser — NOT textual slices — so the assertions bind to
// the actual task list and their inputs, and enforce VALIDATION-BEFORE-PUBLICATION ordering (the
// CodeSign Validation gate must run before the Marketplace publish task in the publish stage).

const PIPELINE_URL = new URL('../../../../.pipelines/OneBranch.Official.yml', import.meta.url);
const pipeline = readFileSync(fileURLToPath(PIPELINE_URL), 'utf8');

interface ParsedTask {
  readonly id: string;
  readonly index: number; // ordinal position among all tasks in the file (for ordering checks)
  readonly inputs: Record<string, string>;
  /** The name of the JOB (`- job:` / `- deployment:` / `- releaseJob:`) that this task executes
   *  in — so a gate can be bound to the ACTUAL executing publish/sign job, not merely its stage
   *  (a gate in a sibling non-executing job in the same stage must not satisfy the check). */
  readonly job: string;
  /** True unless the task carries `enabled: false` — a DISABLED task does not run, so a disabled
   *  validation gate must NOT satisfy a gate check (pass 47 finding #3). */
  readonly enabled: boolean;
  /** The task's own `condition:` expression (folded), or '' if none — so a gate task that is
   *  conditionally SKIPPED (`condition: false` / a non-always condition) does not silently pass a
   *  gate check (pass 48 finding #3). */
  readonly condition: string;
  /** True iff the task carries `continueOnError: true` — a NON-BLOCKING task whose failure does not
   *  fail the pipeline. A CodeSign Validation / break gate marked continueOnError is DEFEATED (its
   *  finding is ignored), so a validation gate must NOT be continueOnError (pass 52 finding #3). */
  readonly continueOnError: boolean;
}
/** Any executable/step entry in a job's `steps:` (a `- task:`, `- script:`/`- bash:`/`- pwsh:`/
 *  `- powershell:`, `- checkout:`, or a `- download:` artifact shortcut), in SOURCE ORDER via the
 *  shared `index`, so an INTERVENING step that could MUTATE/REPLACE the validated artifact between
 *  validation and publication is detectable (pass 52 finding #3; download shortcut pass 53 finding
 *  #3). `script` holds the step's raw body text (for a script/download step) or ''. */
interface ParsedStep {
  readonly kind: 'task' | 'script' | 'checkout' | 'download';
  readonly id: string; // task id, script kind (`script`/`bash`/…), 'checkout', or 'download'
  readonly index: number;
  readonly job: string;
  readonly script: string; // raw body of a script/download step (comment-stripped), else ''
  readonly inputs: Record<string, string>; // task/download inputs, else {}
}
interface ParsedStage {
  readonly name: string;
  readonly tasks: ParsedTask[];
  /** Every step (task/script/checkout) in the stage, in source order (pass 52 finding #3). */
  readonly steps: ParsedStep[];
  /** Job/stage-level `key: value` settings seen in the stage (e.g. ob_sdl_codeSignValidation_enabled). */
  readonly settings: Record<string, string>;
  /** The stage's `condition:` expression (folded to one line), or '' if none — so a publish/sign
   *  stage's branch/publishExtension gate is bound, not assumed (pass 47 finding #3). */
  condition: string;
  /** The stage's `dependsOn:` targets, so publish→sign→build ordering is bound (pass 47 finding #3). */
  dependsOn: string[];
  /** Every `artifactName:` consumed/produced in the stage — the signed-artifact HANDOFF (pass 47
   *  finding #3). */
  artifactNames: string[];
  /** Artifact names consumed PER JOB (keyed by job name), so the publish JOB's OWN input can be
   *  proven to be the SIGNED artifact — not merely that SOME job in the stage consumes it while the
   *  actual publish job consumes an unsigned drop (pass 48 finding #3). */
  jobArtifacts: Record<string, string[]>;
  /** The `environment:` name targeted PER deployment job (keyed by job name), so the signing task's
   *  OWN job can be proven to target the governed protected environment — not a decoy deployment
   *  (pass 49 finding #3). */
  jobEnvironments: Record<string, string>;
  /** The job-level `condition:` expression PER job (keyed by job name), or absent if none — so a
   *  signing/publish JOB that is DISABLED or conditionally skipped (`condition: false`) cannot pass
   *  a gate check even while the stage condition looks strict (pass 51 finding #4). */
  jobConditions: Record<string, string>;
}

/** Strip a trailing YAML comment (` #…` outside quotes) and a whole-line comment. */
function stripComment(line: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function indentOf(line: string): number {
  const m = /^( *)/.exec(line);
  return m ? m[1]!.length : 0;
}

/** Compute the set of line indices that are the CONTENT of a YAML BLOCK SCALAR (`key: |` / `>`
 *  with optional chomping/indent indicators and an optional trailing comment), so the pipeline
 *  parser SKIPS them. Without this, task-like text inside a `run: |` / `script: |` script (e.g. a
 *  `- task: Evil@1` line in a shell heredoc) would be parsed as an executable pipeline task. A
 *  block scalar's content is every subsequent line that is blank OR indented MORE than the key
 *  line; it ends at the first non-blank line indented at or below the key. Operates on RAW lines
 *  (indentation preserved). */
function blockScalarContentLines(rawLines: readonly string[]): Set<number> {
  const skip = new Set<number>();
  for (let i = 0; i < rawLines.length; i++) {
    // A block-scalar header: `<key>: |`/`>` (+ optional +/-/digit indicators) then EOL or a comment.
    if (!/:\s*[|>][+\-0-9]*\s*(#.*)?$/.test(rawLines[i]!)) continue;
    const keyIndent = indentOf(rawLines[i]!);
    for (let j = i + 1; j < rawLines.length; j++) {
      if (rawLines[j]!.trim().length === 0) { skip.add(j); continue; } // blank lines belong to it
      if (indentOf(rawLines[j]!) <= keyIndent) break; // dedent ends the block scalar
      skip.add(j);
    }
  }
  return skip;
}

/** Parse the pipeline into ordered stages, each with its ordered task list (id + inputs) and
 *  stage-level settings. A small indentation-aware parser over the reviewed YAML subset that
 *  SKIPS block-scalar content ({@link blockScalarContentLines}) so task-like text inside a
 *  `run: |` script is never parsed as a task. */
function parsePipeline(text: string): ParsedStage[] {
  const rawLines = text.split(/\r?\n/);
  const blockScalarLines = blockScalarContentLines(rawLines);
  const lines = rawLines.map(stripComment);
  const stages: ParsedStage[] = [];
  let cur: ParsedStage | null = null;
  let curStageIndent = -1;
  let curJob = '';
  let curJobChildIndent = -1;
  let taskOrdinal = 0;
  for (let i = 0; i < lines.length; i++) {
    if (blockScalarLines.has(i)) continue; // inside a block scalar — not structural YAML
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const stageM = /^\s*-\s*stage:\s*(\S+)\s*$/.exec(line);
    if (stageM) {
      cur = { name: stageM[1]!, tasks: [], steps: [], settings: {}, condition: '', dependsOn: [], artifactNames: [], jobArtifacts: {}, jobEnvironments: {}, jobConditions: {} };
      stages.push(cur);
      curStageIndent = indentOf(line);
      curJob = ''; // a new stage resets the current job binding
      curJobChildIndent = -1;
      continue;
    }
    if (!cur) continue;
    const stagePropIndent = curStageIndent + 2; // stage-item sibling keys (dependsOn/condition/jobs)
    // A JOB header (`- job:` / `- deployment:` / `- releaseJob:`) binds subsequent tasks to it.
    const jobM = /^\s*-\s*(?:job|deployment|releaseJob):\s*(\S+)\s*$/.exec(line);
    if (jobM) { curJob = jobM[1]!; curJobChildIndent = indentOf(line) + 2; continue; }
    // A deployment job's `environment:` (scalar name or a block `name:`), bound to the current job.
    const envM = /^\s*environment:\s*(\S.*)?$/.exec(line);
    if (envM && curJob.length > 0) {
      if (envM[1] && envM[1].trim().length > 0) cur.jobEnvironments[curJob] = unquoteScalar(envM[1].trim());
      else {
        // Block form: find the `name:` sub-key.
        const envIndent = indentOf(line);
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]!.trim().length === 0) continue;
          if (indentOf(lines[j]!) <= envIndent) break;
          const nm = /^\s*name:\s*(\S.*)$/.exec(lines[j]!);
          if (nm) { cur.jobEnvironments[curJob] = unquoteScalar(nm[1]!.trim()); break; }
        }
      }
      continue;
    }
    // Stage-level `condition:` (bound only at the stage-property indent, so a job condition is not
    // mistaken for it). Folded (`>-`/`>`/`|`) values gather subsequent more-indented lines.
    const condM = /^(\s*)condition:\s*(.*)$/.exec(line);
    if (condM && condM[1]!.length === stagePropIndent) {
      let val = condM[2]!.trim();
      if (/^[|>][+\-0-9]*$/.test(val)) {
        const parts: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]!.trim().length === 0) continue;
          if (indentOf(lines[j]!) <= condM[1]!.length) break;
          parts.push(lines[j]!.trim());
        }
        val = parts.join(' ');
      }
      cur.condition = val;
      continue;
    }
    // JOB-level `condition:` (a direct child of the current job header) — captured so a signing/
    // publish job that is DISABLED or conditionally skipped is detectable (pass 51 finding #4). A
    // task-level condition sits DEEPER than the job-child indent, so it is not misattributed here.
    if (condM && curJob.length > 0 && condM[1]!.length === curJobChildIndent) {
      let val = condM[2]!.trim();
      if (/^[|>][+\-0-9]*$/.test(val)) {
        const parts: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]!.trim().length === 0) continue;
          if (indentOf(lines[j]!) <= condM[1]!.length) break;
          parts.push(lines[j]!.trim());
        }
        val = parts.join(' ');
      }
      cur.jobConditions[curJob] = unquoteScalar(val);
      continue;
    }
    const depM = /^(\s*)dependsOn:\s*(.*)$/.exec(line);
    if (depM && depM[1]!.length === stagePropIndent) {
      const inline = depM[2]!.trim();
      if (inline.length > 0 && inline !== '[]') {
        // Inline scalar or flow list `[a, b]`.
        const flow = /^\[(.*)\]$/.exec(inline);
        if (flow) cur.dependsOn.push(...flow[1]!.split(',').map((s) => unquoteScalar(s.trim())).filter(Boolean));
        else cur.dependsOn.push(unquoteScalar(inline));
      } else {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]!.trim().length === 0) continue;
          if (indentOf(lines[j]!) <= depM[1]!.length) break;
          const itemM = /^\s*-\s*(\S+)\s*$/.exec(lines[j]!);
          if (itemM) cur.dependsOn.push(unquoteScalar(itemM[1]!));
        }
      }
      continue;
    }
    // Any `artifactName:` in the stage records the signed-artifact handoff — both stage-wide and
    // bound to the CURRENT job (so the publish JOB's OWN input can be proven, pass 48 finding #3).
    const artM = /^\s*(?:-\s*)?artifactName:\s*(\S+)\s*$/.exec(line);
    if (artM) {
      const an = unquoteScalar(artM[1]!);
      cur.artifactNames.push(an);
      (cur.jobArtifacts[curJob] ??= []).push(an);
      continue;
    }
    const taskM = /^(\s*)-\s*task:\s*(\S+)\s*$/.exec(line);
    if (taskM) {
      const itemIndent = taskM[1]!.length;
      const inputs: Record<string, string> = {};
      let enabled = true;
      let taskCondition = '';
      let continueOnError = false;
      // Find this task's `inputs:` block, `enabled:` flag, `condition:`, and `continueOnError:`
      // (task-item children), then collect the inputs until a dedent to the task-item level.
      for (let j = i + 1; j < lines.length; j++) {
        if (blockScalarLines.has(j)) continue; // skip block-scalar content
        const l = lines[j]!;
        if (l.trim().length === 0) continue;
        const ind = indentOf(l);
        if (ind <= itemIndent) break; // left this task item
        const enM = /^\s*enabled:\s*(\S+)\s*$/.exec(l);
        if (enM && ind === itemIndent + 2) { enabled = unquoteScalar(enM[1]!).toLowerCase() !== 'false'; continue; }
        const coeM = /^\s*continueOnError:\s*(\S+)\s*$/.exec(l);
        if (coeM && ind === itemIndent + 2) { continueOnError = unquoteScalar(coeM[1]!).toLowerCase() === 'true'; continue; }
        const tcM = /^\s*condition:\s*(.*)$/.exec(l);
        if (tcM && ind === itemIndent + 2) {
          let tval = tcM[1]!.trim();
          // Gather a FOLDED/BLOCK task condition (`condition: >-` then indented lines) so a
          // MULTILINE false/non-always task condition is captured, not read as the bare `>-`
          // indicator (pass 49 finding #3).
          if (/^[|>][+\-0-9]*$/.test(tval)) {
            const parts: string[] = [];
            for (let k = j + 1; k < lines.length; k++) {
              if (lines[k]!.trim().length === 0) continue;
              if (indentOf(lines[k]!) <= ind) break;
              parts.push(lines[k]!.trim());
            }
            tval = parts.join(' ');
          }
          taskCondition = unquoteScalar(tval);
          continue;
        }
        const inM = /^\s*inputs:\s*$/.exec(l);
        if (!inM) continue;
        const inputsIndent = ind;
        for (let k = j + 1; k < lines.length; k++) {
          if (blockScalarLines.has(k)) continue; // skip block-scalar content
          const il = lines[k]!;
          if (il.trim().length === 0) continue;
          const iind = indentOf(il);
          if (iind <= inputsIndent) break; // left the inputs block
          const kvM = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(il);
          if (kvM && iind === inputsIndent + 2) inputs[kvM[1]!] = unquoteScalar(kvM[2]!.trim());
        }
        break;
      }
      const ord = taskOrdinal++;
      cur.tasks.push({ id: taskM[2]!, index: ord, inputs, job: curJob, enabled, condition: taskCondition, continueOnError });
      cur.steps.push({ kind: 'task', id: taskM[2]!, index: ord, job: curJob, script: '', inputs });
      continue;
    }
    // A SCRIPT/executable step (`- script:`/`- bash:`/`- pwsh:`/`- powershell:`), `- checkout:`, or
    // a `- download:` artifact shortcut. The raw body (comment-stripped, all lines of the step item)
    // is captured, and simple child `key: value` inputs (e.g. a download's `artifact:`/`patterns:`/
    // `path:`) are parsed, so an INTERVENING step that MUTATES/REPLACES the validated artifact
    // between validation and publication is detectable (pass 52 finding #3; download pass 53 #3).
    const stepM = /^(\s*)-\s*(script|bash|pwsh|powershell|checkout|download):\s*(.*)$/.exec(line);
    if (stepM) {
      const itemIndent = stepM[1]!.length;
      const bodyLines: string[] = [stepM[3]!];
      const stepInputs: Record<string, string> = {};
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trim().length === 0) continue;
        if (indentOf(lines[j]!) <= itemIndent) break; // left this step item
        bodyLines.push(lines[j]!);
        const kvM = /^\s*([A-Za-z0-9_]+)\s*:\s*(\S.*)$/.exec(lines[j]!);
        if (kvM && indentOf(lines[j]!) === itemIndent + 2) stepInputs[kvM[1]!] = unquoteScalar(kvM[2]!.trim());
      }
      cur.steps.push({
        kind: stepM[2] === 'checkout' ? 'checkout' : stepM[2] === 'download' ? 'download' : 'script',
        id: stepM[2]!,
        index: taskOrdinal++,
        job: curJob,
        script: bodyLines.join('\n'),
        inputs: stepInputs,
      });
      continue;
    }
    // Stage/job-level `key: value` setting (e.g. a variables entry). Recorded loosely by key.
    const kv = /^\s*([A-Za-z0-9_]+)\s*:\s*(\S.*)$/.exec(line);
    if (kv) cur.settings[kv[1]!] = unquoteScalar(kv[2]!.trim());
  }
  return stages;
}

function unquoteScalar(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

const stages = parsePipeline(pipeline);
function stage(name: string): ParsedStage {
  const s = stages.find((x) => x.name === name);
  assert.ok(s, `pipeline must declare the '${name}' stage`);
  return s!;
}
function findTask(s: ParsedStage, pred: (id: string) => boolean): ParsedTask | undefined {
  return s.tasks.find((t) => pred(t.id));
}

/** Parse the top-level `variables:` block's `- name: X` / `value: Y` entries, so a variable
 *  referenced by the pipeline (e.g. `$(SigningEnvironment)`) can be resolved to its CONCRETE value
 *  and a decoy environment/branch is detectable (pass 48 finding #3). */
function parseVariables(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/).map(stripComment);
  const out: Record<string, string> = {};
  let inVars = false;
  let varsIndent = -1;
  let pendingName: string | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const vm = /^(\s*)variables:\s*$/.exec(line);
    if (vm) { inVars = true; varsIndent = vm[1]!.length; continue; }
    if (!inVars) continue;
    const ind = indentOf(line);
    if (ind <= varsIndent) break; // left the variables block
    const nameM = /^\s*-\s*name:\s*(\S+)\s*$/.exec(line);
    if (nameM) { pendingName = unquoteScalar(nameM[1]!); continue; }
    const valM = /^\s*value:\s*(.*)$/.exec(line);
    if (valM && pendingName) { out[pendingName] = unquoteScalar(valM[1]!.trim()); pendingName = null; continue; }
  }
  return out;
}
const variables = parseVariables(pipeline);

test('OneBranch.Official SIGN stage requests the Real SignType via the parsed signing task inputs (finding #9)', () => {
  const sign = stage('sign');
  const signing = findTask(sign, (id) => id === 'onebranch.pipeline.signing@1');
  assert.ok(signing, 'the sign stage declares the governed onebranch.pipeline.signing@1 task');
  assert.equal(signing!.inputs.command, 'sign', 'the signing task command is sign');
  assert.equal(signing!.inputs.signing_environment, 'azure_devops', 'signing is brokered by the governed OneBranch signing environment');
  assert.equal(signing!.inputs.signing_profile, 'external_distribution', 'the Real SignType profile (external_distribution) is requested — parsed from the task inputs');
});

test('OneBranch.Official SIGN stage runs a fail-closed CodeSign Validation gate AFTER signing IN THE SAME executing job (parsed order + job binding, pass 46 finding #3)', () => {
  const sign = stage('sign');
  const signing = findTask(sign, (id) => id === 'onebranch.pipeline.signing@1');
  assert.ok(signing, 'the sign stage declares the signing task');
  // Bind the gates to the ACTUAL executing signing JOB (the deployment job that runs signing), not
  // merely the stage (pass 46 finding #3).
  const signJob = signing!.job;
  assert.ok(signJob.length > 0, 'the signing task is bound to a named (deployment) job');
  const inSameJob = (pred: (id: string) => boolean): ParsedTask | undefined =>
    sign.tasks.find((t) => t.job === signJob && pred(t.id));
  const csv = inSameJob((id) => id.endsWith('CodeSignValidation@0'));
  const post = inSameJob((id) => id.endsWith('PostAnalysis@2'));
  assert.ok(csv && post, `the signing JOB '${signJob}' itself has CodeSignValidation + PostAnalysis tasks`);
  // The gates must be ENABLED — a `enabled: false` validation task does not run and must not
  // satisfy the check (pass 47 finding #3).
  assert.ok(signing!.enabled, 'the signing task is enabled');
  assert.ok(csv!.enabled, 'the sign-stage CodeSign Validation task is enabled (not disabled)');
  assert.ok(post!.enabled, 'the sign-stage PostAnalysis break-gate is enabled (not disabled)');
  // ORDER, within the SAME executing job: sign, then validate, then break-gate.
  assert.ok(signing!.index < csv!.index, 'CodeSign Validation runs AFTER the signing task (same job)');
  assert.ok(csv!.index < post!.index, 'the PostAnalysis break-gate runs AFTER CodeSign Validation (same job)');
  // The job-level SDL CodeSign toggle is enabled (a stage/job setting).
  assert.equal(sign.settings.ob_sdl_codeSignValidation_enabled, 'true', 'the sign job enables the SDL CodeSign Validation toggle');
  // The break-gate inputs fail closed on any Warning+ finding and on missing tool logs.
  assert.equal(post!.inputs.CodesignValidation, 'true', 'the sign PostAnalysis enables the CodeSign break-on evaluation');
  assert.equal(post!.inputs.CodesignValidationBreakOn, 'WarningAbove', 'the sign gate breaks on Warning-or-higher CodeSign findings');
  assert.equal(post!.inputs.ToolLogsNotFoundAction, 'Error', 'the sign gate fails closed when CodeSign Validation logs are missing');
});

test('OneBranch.Official PUBLISH stage validates BEFORE it publishes IN THE SAME executing job (parsed order + job binding, pass 46 finding #3)', () => {
  const pub = stage('publish');
  const publishTask = findTask(pub, (id) => id.endsWith('PublishAzureDevOpsExtension@4'));
  assert.ok(publishTask, 'the publish stage declares the Marketplace publish task');
  // Bind the gates to the ACTUAL executing publish JOB (the job that runs the Marketplace publish),
  // not merely the stage — a CodeSign Validation gate in a sibling, non-executing job in the same
  // stage must NOT satisfy the check (pass 46 finding #3).
  const publishJob = publishTask!.job;
  assert.ok(publishJob.length > 0, 'the publish task is bound to a named job');
  const inSameJob = (id: string): ParsedTask | undefined =>
    pub.tasks.find((t) => t.job === publishJob && t.id.endsWith(id));
  const csv = inSameJob('CodeSignValidation@0');
  const post = inSameJob('PostAnalysis@2');
  assert.ok(csv && post, `the publish JOB '${publishJob}' itself re-verifies (CodeSignValidation + PostAnalysis) before publishing`);
  // The gates must be ENABLED — a disabled validation task must not satisfy the check (finding #3).
  assert.ok(publishTask!.enabled, 'the Marketplace publish task is enabled');
  assert.ok(csv!.enabled, 'the publish-stage CodeSign Validation task is enabled (not disabled)');
  assert.ok(post!.enabled, 'the publish-stage PostAnalysis break-gate is enabled (not disabled)');
  // VALIDATION-BEFORE-PUBLICATION, within the SAME executing job: the CodeSign re-verification AND
  // its break-gate must precede the Marketplace publish task, so a run that skipped/faked signing
  // cannot publish.
  assert.ok(csv!.index < publishTask!.index, 'CodeSign Validation runs BEFORE the Marketplace publish task (same job)');
  assert.ok(post!.index < publishTask!.index, 'the PostAnalysis break-gate runs BEFORE the Marketplace publish task (same job)');
  assert.ok(csv!.index < post!.index, 'the publish-job break-gate runs AFTER its CodeSign Validation');
  // The publish-stage break-gate has its own fail-closed inputs (independent of the sign stage).
  assert.equal(post!.inputs.CodesignValidation, 'true', 'the publish PostAnalysis enables the CodeSign break-on evaluation');
  assert.equal(post!.inputs.CodesignValidationBreakOn, 'WarningAbove', 'the publish gate breaks on Warning-or-higher CodeSign findings');
  assert.equal(post!.inputs.ToolLogsNotFoundAction, 'Error', 'the publish gate fails closed when CodeSign Validation logs are missing');
});

test('OneBranch.Official binds signing to an environment-gated deployment job (non-removable-in-review gate, finding #9)', () => {
  // The signing task lives inside a `deployment:` job that TARGETS the signing environment, so the
  // environment's Branch Control + pipeline-permission checks run before any signing step. This is
  // a structural property of the sign stage text (the deployment/environment binding).
  const signStart = pipeline.indexOf('- stage: sign');
  const nextStage = pipeline.indexOf('- stage:', signStart + 12);
  const signText = pipeline.slice(signStart, nextStage < 0 ? pipeline.length : nextStage);
  assert.match(signText, /deployment:\s*sign_vsix/, 'signing is a deployment job (environment-gated), not a plain job');
  assert.match(signText, /environment:\s*\$\(SigningEnvironment\)/, 'the deployment job targets the governed signing environment');
  const envIdx = signText.indexOf('environment: $(SigningEnvironment)');
  const signIdx = signText.indexOf('- task: onebranch.pipeline.signing@1');
  assert.ok(envIdx >= 0 && signIdx >= 0 && envIdx < signIdx, 'the signing task is inside the environment-gated deployment job');
});

test('OneBranch.Official binds stage conditions, dependencies, artifact handoff, and the publish service connection (pass 47 finding #3)', () => {
  const build = stage('build');
  const sign = stage('sign');
  const pub = stage('publish');

  // (1) DEPENDENCIES: sign depends on build, publish depends on sign — so publish cannot run
  // without a completed sign stage (no publish of an unsigned artifact).
  assert.ok(sign.dependsOn.includes('build'), 'the sign stage dependsOn build');
  assert.ok(pub.dependsOn.includes('sign'), 'the publish stage dependsOn sign (cannot run before signing)');

  // (2) CONDITIONS: both sign and publish are branch-gated to the trusted PublishBranch, and
  // publish additionally requires the publishExtension parameter — so a feature-branch or an
  // un-opted run neither signs nor publishes.
  assert.match(sign.condition, /succeeded\(\)/, 'the sign stage requires the prior stage succeeded');
  assert.match(sign.condition, /Build\.SourceBranch.*PublishBranch/, 'the sign stage is gated to the trusted PublishBranch');
  assert.match(pub.condition, /succeeded\(\)/, 'the publish stage requires the prior stage succeeded');
  assert.match(pub.condition, /publishExtension.*true/, 'the publish stage requires the publishExtension parameter be true');
  assert.match(pub.condition, /Build\.SourceBranch.*PublishBranch/, 'the publish stage is gated to the trusted PublishBranch');

  // (3) ARTIFACT HANDOFF: the publish stage CONSUMES the artifact PRODUCED by the sign stage's
  // deployment job (`drop_sign_sign_vsix`), so it publishes the SIGNED VSIX, not the build stage's
  // unsigned drop. The publish stage must reference that exact signed-artifact name.
  assert.ok(
    pub.artifactNames.includes('drop_sign_sign_vsix'),
    `the publish stage consumes the signed artifact drop_sign_sign_vsix (got: ${pub.artifactNames.join(', ')})`,
  );
  // The publish stage must NOT consume the build stage's UNSIGNED package drop.
  assert.ok(
    !pub.artifactNames.includes('drop_build_package'),
    'the publish stage does NOT consume the unsigned build drop (it publishes the signed handoff)',
  );
  // The sign stage consumes the build stage's package drop (build → sign handoff).
  assert.ok(sign.artifactNames.includes('drop_build_package'), 'the sign stage consumes the build stage package drop');

  // (4) SERVICE-CONNECTION IDENTITY: the Marketplace publish task binds the exact, HARDCODED
  // service connection (`ADO-Plugin Publishing`) via `connectTo: VsTeam` — so ADO can statically
  // discover it and enforce its Approvals-and-checks. A `$(var)` reference is rejected.
  const publishTask = findTask(pub, (id) => id.endsWith('PublishAzureDevOpsExtension@4'))!;
  assert.equal(publishTask.inputs.connectTo, 'VsTeam', 'the publish task connects to the Visual Studio Marketplace (VsTeam)');
  assert.equal(
    publishTask.inputs.connectedServiceName,
    'ADO-Plugin Publishing',
    'the publish task binds the exact hardcoded Marketplace service connection (statically discoverable for ADO checks)',
  );
});

/** Split the TOP-LEVEL argument list of a whitespace-stripped `and(<args>)` expression into its
 *  direct conjuncts (respecting nested parens), or null if it is not an `and(...)`-rooted
 *  expression. Used to bind a required predicate to a DIRECT conjunct of the root gate — a
 *  SEMANTIC check, not a substring match (pass 50 finding #1). */
function andConjuncts(cond: string): string[] | null {
  const c = cond.replace(/\s+/g, '');
  if (!/^and\(/.test(c) || !c.endsWith(')')) return null;
  const inner = c.slice(4, -1);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth > 0) depth--; }
    else if (ch === ',' && depth === 0) { out.push(inner.slice(start, i)); start = i + 1; }
  }
  out.push(inner.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Assert a stage/task condition is a NON-PERMISSIVE `and(...)` gate whose required predicates are
 *  DIRECT top-level conjuncts (SEMANTIC, not a substring match) — so a predicate placed in a DEAD
 *  or NESTED expression (`and(succeeded(), eq('x', eq(branch)))`, `and(succeeded(), or(eq(branch),
 *  true))`) cannot satisfy the gate (pass 50 finding #1). `requiredConjuncts` are the exact
 *  whitespace-stripped conjunct strings that MUST each appear as a direct operand of the root
 *  `and(...)`. The whole expression must also contain NO permissive/negated construct. */
function assertStrictAndCondition(cond: string, label: string, requiredConjuncts: readonly string[] = [], exact = false): void {
  const c = cond.replace(/\s+/g, '');
  const conjuncts = andConjuncts(cond);
  assert.ok(conjuncts !== null, `${label} condition is an and(...) gate (got: ${cond})`);
  // succeeded() must be a DIRECT conjunct (not nested in a dead sub-expression).
  assert.ok(conjuncts!.includes('succeeded()'), `${label} condition has succeeded() as a DIRECT conjunct (got conjuncts: ${conjuncts!.join(' | ')})`);
  // Each required predicate must be a DIRECT conjunct — its POSITION gates the run, not merely its
  // presence somewhere in the string.
  for (const req of requiredConjuncts) {
    assert.ok(
      conjuncts!.includes(req),
      `${label} condition has '${req}' as a DIRECT conjunct of the root and(...) (not a dead/nested position); got conjuncts: ${conjuncts!.join(' | ')}`,
    );
  }
  // EXACT semantics (pass 51 finding #4): the gate must contain ONLY `succeeded()` and the required
  // predicates — no EXTRA conjunct, so a decoy always-true conjunct (masking a weakened check) or an
  // always-false conjunct (silently disabling signing/publish) is rejected.
  if (exact) {
    const allowed = new Set<string>(['succeeded()', ...requiredConjuncts]);
    for (const cj of conjuncts!) {
      assert.ok(allowed.has(cj), `${label} condition has ONLY the allowed conjuncts (no decoy/false conjunct); unexpected '${cj}' in ${conjuncts!.join(' | ')}`);
    }
    assert.equal(conjuncts!.length, allowed.size, `${label} condition is EXACTLY {succeeded(), ${requiredConjuncts.join(', ')}} (no missing/duplicate/extra); got ${conjuncts!.join(' | ')}`);
  }
  // No permissive/negated construct ANYWHERE in the expression.
  assert.ok(!/always\(/.test(c), `${label} condition must not use always()`);
  assert.ok(!/succeededOrFailed\(/.test(c), `${label} condition must not use succeededOrFailed()`);
  assert.ok(!/(^|[(,])or\(/.test(c), `${label} condition must not use a permissive or(...)`);
  assert.ok(!/ne\(variables\['Build\.SourceBranch'\]/.test(c), `${label} condition must not use a NEGATED ne(...) branch check`);
  assert.ok(!/not\(eq\(variables\['Build\.SourceBranch'\]/.test(c), `${label} condition must not wrap the branch eq(...) in not(...)`);
}

/** Assert a signing/publish JOB is NOT disabled: it either carries NO job-level `condition:` (the
 *  stage gate governs) or a STRICT `and(...)` gate (succeeded() + the same required predicates,
 *  EXACT). A `condition: false` or any decoy/permissive job condition — which would silently skip
 *  the signing or publish job while the stage condition still looks strict — is rejected (pass 51
 *  finding #4). */
function assertJobNotDisabled(s: ParsedStage, job: string, requiredConjuncts: readonly string[]): void {
  const cond = s.jobConditions[job];
  if (cond === undefined || cond === '') return; // no job-level skip → governed by the stage gate
  assert.notEqual(cond.replace(/\s+/g, '').toLowerCase(), 'false', `job '${job}' must not be disabled by condition: false`);
  assertStrictAndCondition(cond, `job '${job}'`, requiredConjuncts, true);
}

test('OneBranch.Official signing/publish conditions are strictly gated (no permissive forms), and the signing environment is the concrete governed one (pass 48 finding #3)', () => {
  const sign = stage('sign');
  const pub = stage('publish');
  // STRICT conditions: an `and(...)` of succeeded + the branch eq (+ publishExtension for publish),
  // each a DIRECT conjunct (SEMANTIC — not merely present in the string), with no
  // always()/or()/negated permissive escape.
  const branchEq = "eq(variables['Build.SourceBranch'],variables['PublishBranch'])";
  const publishExtEq = "eq('${{parameters.publishExtension}}',true)";
  assertStrictAndCondition(sign.condition, 'sign stage', [branchEq], true);
  assertStrictAndCondition(pub.condition, 'publish stage', [branchEq, publishExtEq], true);

  // DECOY protected environment: the signing deployment job targets `$(SigningEnvironment)`, and
  // that variable resolves to the CONCRETE governed environment name — not an arbitrary decoy.
  assert.equal(
    variables.SigningEnvironment,
    'ChaosStudio-ESRP-Signing-Prod',
    'the SigningEnvironment variable is the concrete governed ESRP signing environment (no decoy)',
  );
  assert.equal(variables.PublishBranch, 'refs/heads/main', 'the trusted PublishBranch is refs/heads/main');
});

test('OneBranch.Official sign/publish gate tasks are enabled AND not conditionally skipped; the publish JOB itself consumes the signed artifact (pass 48 finding #3)', () => {
  const sign = stage('sign');
  const pub = stage('publish');
  // GATE tasks must be ENABLED and carry NO skip-condition (a `condition: false`/non-always
  // condition would skip the validation even while enabled).
  const gateTasks = [
    ...sign.tasks.filter((t) => t.id.endsWith('CodeSignValidation@0') || t.id.endsWith('PostAnalysis@2')),
    ...pub.tasks.filter((t) => t.id.endsWith('CodeSignValidation@0') || t.id.endsWith('PostAnalysis@2')),
  ];
  assert.ok(gateTasks.length >= 4, 'both stages declare the CodeSign Validation + PostAnalysis gate tasks');
  for (const t of gateTasks) {
    assert.ok(t.enabled, `gate task ${t.id} is enabled`);
    assert.equal(t.condition, '', `gate task ${t.id} carries no skip-condition (runs unconditionally within its gated job)`);
  }

  // The publish JOB that runs the Marketplace publish must consume the SIGNED artifact ITSELF — a
  // sibling job consuming the signed drop while the publish job consumes an unsigned one is
  // rejected by binding the artifact to the publish task's OWN job (pass 48 finding #3).
  const publishTask = pub.tasks.find((t) => t.id.endsWith('PublishAzureDevOpsExtension@4'))!;
  const publishJobArtifacts = pub.jobArtifacts[publishTask.job] ?? [];
  assert.ok(
    publishJobArtifacts.includes('drop_sign_sign_vsix'),
    `the publish JOB '${publishTask.job}' itself consumes the signed artifact drop_sign_sign_vsix (got: ${publishJobArtifacts.join(', ')})`,
  );
  assert.ok(
    !publishJobArtifacts.includes('drop_build_package'),
    'the publish JOB does not consume the unsigned build drop',
  );
});

test('OneBranch.Official binds condition + environment + validation + artifact + publish input to ONE execution chain (pass 49 finding #3)', () => {
  const sign = stage('sign');
  const pub = stage('publish');

  // --- SIGN chain: the signing task's OWN deployment job targets the CONCRETE governed
  // environment, and the CodeSign Validation + break-gate run (enabled, unconditional) in THAT job.
  const signing = sign.tasks.find((t) => t.id === 'onebranch.pipeline.signing@1')!;
  const signEnv = sign.jobEnvironments[signing.job];
  assert.equal(signEnv, '$(SigningEnvironment)', `the signing task's OWN job targets the governed environment (no decoy); got ${signEnv}`);
  assert.equal(variables.SigningEnvironment, 'ChaosStudio-ESRP-Signing-Prod', 'the environment variable resolves to the concrete governed value');
  const signCsv = sign.tasks.find((t) => t.job === signing.job && t.id.endsWith('CodeSignValidation@0'))!;
  const signPost = sign.tasks.find((t) => t.job === signing.job && t.id.endsWith('PostAnalysis@2'))!;
  assert.ok(signCsv && signPost, 'the signing JOB itself runs CodeSign Validation + PostAnalysis');
  assert.ok(signCsv.enabled && signCsv.condition === '', 'the sign-job CodeSign Validation is enabled and unconditional');
  assert.ok(signPost.enabled && signPost.condition === '', 'the sign-job break-gate is enabled and unconditional');
  assert.ok(signing.index < signCsv.index && signCsv.index < signPost.index, 'sign → validate → break-gate order');

  // --- SIGN stage strictly branch-gated (positive, non-negated eq) as a DIRECT conjunct, with
  // EXACTLY those conjuncts (no decoy/false extra conjunct — pass 51 finding #4).
  const branchEq = "eq(variables['Build.SourceBranch'],variables['PublishBranch'])";
  const publishExtEq = "eq('${{parameters.publishExtension}}',true)";
  assertStrictAndCondition(sign.condition, 'sign stage', [branchEq], true);

  // --- PUBLISH chain: strict branch + publishExtension gate (EXACTLY those, each a DIRECT
  // conjunct); the publish JOB consumes the SIGNED artifact; CodeSign Validation re-verifies
  // (enabled, unconditional) BEFORE the Marketplace publish; and the publish task's vsixFile input
  // is the signed VSIX.
  assertStrictAndCondition(pub.condition, 'publish stage', [branchEq, publishExtEq], true);
  assert.ok(pub.dependsOn.includes('sign'), 'publish dependsOn sign (cannot run before signing)');

  // The SIGNING and PUBLISH critical tasks themselves must be ENABLED and unconditional, and their
  // JOBS must not be disabled by a job-level skip condition (pass 51 finding #4).
  assert.ok(signing.enabled && signing.condition === '', 'the signing task is enabled and unconditional (not disabled/skipped)');
  assertJobNotDisabled(sign, signing.job, [branchEq]);

  const publishTask = pub.tasks.find((t) => t.id.endsWith('PublishAzureDevOpsExtension@4'))!;
  assert.ok(publishTask.enabled && publishTask.condition === '', 'the publish task is enabled and unconditional (not disabled/skipped)');
  assertJobNotDisabled(pub, publishTask.job, [branchEq, publishExtEq]);
  const pubJobArtifacts = pub.jobArtifacts[publishTask.job] ?? [];
  assert.ok(pubJobArtifacts.includes('drop_sign_sign_vsix'), `the publish JOB consumes the signed artifact (got: ${pubJobArtifacts.join(', ')})`);
  assert.ok(!pubJobArtifacts.includes('drop_build_package'), 'the publish JOB does not consume the unsigned build drop');
  const pubCsv = pub.tasks.find((t) => t.job === publishTask.job && t.id.endsWith('CodeSignValidation@0'))!;
  const pubPost = pub.tasks.find((t) => t.job === publishTask.job && t.id.endsWith('PostAnalysis@2'))!;
  assert.ok(pubCsv && pubPost, 'the publish JOB re-verifies (CodeSignValidation + PostAnalysis)');
  assert.ok(pubCsv.enabled && pubCsv.condition === '', 'the publish-job CodeSign Validation is enabled and unconditional');
  assert.ok(pubPost.enabled && pubPost.condition === '', 'the publish-job break-gate is enabled and unconditional');
  assert.ok(pubCsv.index < publishTask.index && pubPost.index < publishTask.index, 'the publish job validates BEFORE it publishes');
  // The publish input publishes the SIGNED VSIX (resolved from the signed artifact), not an
  // arbitrary/unsigned path.
  assert.equal(publishTask.inputs.vsixFile, '$(SignedVsix)', 'the publish task publishes the resolved SIGNED VSIX ($(SignedVsix))');
  assert.equal(publishTask.inputs.connectedServiceName, 'ADO-Plugin Publishing', 'the publish task binds the exact hardcoded Marketplace service connection');
});

test('OneBranch.Official binds the PUBLISHED VSIX to the exact directory that was VALIDATED (pass 51 finding #3)', () => {
  // A tampered/unsigned copy assigned to SignedVsix must not be publishable: prove the published
  // file ($(SignedVsix)) is resolved SOLELY from the SAME signed-artifact directory that the
  // downloaded signed artifact lands in AND that CodeSign Validation re-verifies — so there is no
  // path where an unvalidated file is bound to SignedVsix.
  const SIGNED_DIR = '$(Pipeline.Workspace)/signed';
  const pub = stage('publish');

  // (1) The signed artifact download targetPath — where the governed signed VSIX is materialized.
  const publishStageText = pipeline.slice(pipeline.search(/^\s*-\s*stage:\s*publish\s*$/m));
  const dlM = /artifactName:\s*drop_sign_sign_vsix\s*[\r\n]+\s*targetPath:\s*(\S+)/.exec(publishStageText);
  assert.ok(dlM, 'the publish job declares the signed artifact download with a targetPath');
  assert.equal(unquoteScalar(dlM![1]!), SIGNED_DIR, 'the signed artifact is downloaded to the signed directory');

  // (2) The resolve step derives SignedVsix ONLY from a `find` of that SAME signed directory.
  const findMatches = [...publishStageText.matchAll(/find\s+"([^"]+)"\s+-name\s+'\*\.vsix'/g)];
  assert.equal(findMatches.length, 1, 'exactly one *.vsix find feeds the SignedVsix resolution (no decoy source directory)');
  assert.equal(findMatches[0]![1]!, SIGNED_DIR, 'the resolve step enumerates the signed directory (the validated location)');

  // (3) There is EXACTLY ONE `setvariable SignedVsix`, and it is the found file (`${vsixes[0]}`) —
  // never a hardcoded or alternate path. A second/overriding assignment to a different path fails.
  const setMatches = [...publishStageText.matchAll(/##vso\[task\.setvariable variable=SignedVsix\]([^"\r\n]*)/g)];
  assert.equal(setMatches.length, 1, 'SignedVsix is assigned exactly once (no reassignment to an unvalidated path)');
  assert.equal(setMatches[0]![1]!.trim(), '${vsixes[0]}', 'SignedVsix is bound to the single file found in the signed directory');

  // (4) CodeSign Validation in the publish job re-verifies that SAME directory (bind validate==publish).
  const pubCsvPaths = pub.tasks
    .filter((t) => t.id.endsWith('CodeSignValidation@0'))
    .map((t) => t.inputs.path);
  assert.ok(pubCsvPaths.length >= 1, 'the publish job runs CodeSign Validation');
  for (const p of pubCsvPaths) {
    assert.equal(p, SIGNED_DIR, 'CodeSign Validation validates the SAME signed directory the published VSIX is resolved from');
  }

  // (5) The publish task publishes exactly $(SignedVsix) — the file resolved from, and validated in,
  // the signed directory.
  const publishTask = pub.tasks.find((t) => t.id.endsWith('PublishAzureDevOpsExtension@4'))!;
  assert.equal(publishTask.inputs.vsixFile, '$(SignedVsix)', 'the publish task publishes the resolved, validated SignedVsix');
});

test('OneBranch.Official signing/publish gates are BLOCKING and no step mutates the validated VSIX before publication (pass 52 finding #3)', () => {
  const sign = stage('sign');
  const pub = stage('publish');
  const SIGNED_DIR = '$(Pipeline.Workspace)/signed';

  // (1) NON-BLOCKING VALIDATION is prohibited: every CodeSign Validation + PostAnalysis break gate
  // (both stages) must be BLOCKING — a `continueOnError: true` gate runs but its failure is ignored,
  // so an unsigned/tampered VSIX would pass. (`enabled`/`condition` are already checked elsewhere.)
  const gateTasks = [...sign.tasks, ...pub.tasks].filter(
    (t) => t.id.endsWith('CodeSignValidation@0') || t.id.endsWith('PostAnalysis@2'),
  );
  assert.ok(gateTasks.length >= 4, 'both stages declare CodeSign Validation + PostAnalysis gate tasks');
  for (const t of gateTasks) {
    assert.equal(t.continueOnError, false, `gate task ${t.id} (${t.job}) is BLOCKING (not continueOnError: true) — a non-blocking validation is defeated`);
  }

  // (2) NO INTERVENING ARTIFACT MUTATION: in the publish job, order the steps and prove that
  // between the CodeSign Validation (which validates the signed directory) and the Marketplace
  // publish there is NO EXECUTABLE SCRIPT step and NO step that writes to the SignedVsix path or the
  // validated signed directory — so the exact bytes validated are the bytes published.
  const pubSteps = pub.steps.filter((s) => s.job === 'publish_vsix').sort((a, b) => a.index - b.index);
  const pubCsv = pub.tasks.find((t) => t.job === 'publish_vsix' && t.id.endsWith('CodeSignValidation@0'))!;
  const publishTask = pub.tasks.find((t) => t.id.endsWith('PublishAzureDevOpsExtension@4'))!;
  assert.ok(pubCsv && publishTask, 'the publish job runs CodeSign Validation and the Marketplace publish');
  // A step MUTATES/REPLACES the validated artifact if its script writes to $(SignedVsix) or the
  // signed dir (a redirection `> …`/`>> …`/`tee …`, a `cp`/`mv`/`install`/`rsync`/`ln` target, or a
  // `setvariable SignedVsix` reassignment), if it is a task whose targetPath/targetFolder/
  // downloadPath/path input is the signed directory, OR if it is an ARTIFACT-DOWNLOAD step (a
  // `DownloadPipelineArtifact`/`DownloadBuildArtifacts` task or a `- download:` shortcut) — which can
  // materialize an UNSIGNED artifact over the validated VSIX via the `downloadPath`/`path` alias
  // (pass 53 finding #3).
  const escDir = SIGNED_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isArtifactDownload = (s: ParsedStep): boolean =>
    s.kind === 'download' || (s.kind === 'task' && /Download(?:PipelineArtifact|BuildArtifacts)@\d+$/.test(s.id));
  const mutatesArtifact = (s: ParsedStep): boolean => {
    // Any artifact download between validation and publish is prohibited (fail closed) — it can
    // introduce an unsigned artifact regardless of the exact destination.
    if (isArtifactDownload(s)) return true;
    if (s.kind === 'task' || s.kind === 'download') {
      return Object.entries(s.inputs).some(
        ([k, v]) => /^(?:targetPath|targetFolder|Contents|TargetFolder|downloadPath|path)$/i.test(k) && new RegExp(escDir).test(v),
      );
    }
    const b = s.script;
    if (/##vso\[task\.setvariable\s+variable=SignedVsix\]/.test(b)) return true;
    const writeTargets = new RegExp(`(?:>>?|\\btee\\b|\\bcp\\b|\\bmv\\b|\\binstall\\b|\\brsync\\b|\\bln\\b|\\bdd\\b)[^\\n]*(?:\\$\\(SignedVsix\\)|${escDir})`);
    return writeTargets.test(b);
  };
  const between = pubSteps.filter((s) => s.index > pubCsv.index && s.index < publishTask.index);
  for (const s of between) {
    assert.notEqual(s.kind, 'script', `no executable script step runs between CodeSign Validation and publication (found a ${s.id} step that could overwrite the validated VSIX) (pass 52 finding #3)`);
    assert.ok(!isArtifactDownload(s), `no artifact-download step (${s.id}) runs between CodeSign Validation and publication (it could replace the validated VSIX via downloadPath/path) (pass 53 finding #3)`);
    assert.ok(!mutatesArtifact(s), `the step ${s.id} between validation and publication does not write to the signed artifact/dir (pass 52 finding #3)`);
  }
  // (3) The SignedVsix resolution (the only setvariable) runs BEFORE the CodeSign Validation, so the
  // validated file is the resolved one — and no setvariable of SignedVsix occurs AFTER validation.
  const resolveStep = pubSteps.find((s) => s.kind === 'script' && /##vso\[task\.setvariable\s+variable=SignedVsix\]/.test(s.script));
  assert.ok(resolveStep, 'the publish job resolves SignedVsix in a script step');
  assert.ok(resolveStep!.index < pubCsv.index, 'SignedVsix is resolved BEFORE CodeSign Validation (the validated file is the resolved one)');
  const setAfterValidation = pubSteps.some(
    (s) => s.index > pubCsv.index && /##vso\[task\.setvariable\s+variable=SignedVsix\]/.test(s.script),
  );
  assert.ok(!setAfterValidation, 'SignedVsix is NOT reassigned after validation (no post-validation swap to an unvalidated path)');
});

test('parsePipeline models continueOnError and script steps so a non-blocking gate / intervening mutation is detectable (pass 52 finding #3)', () => {
  const synthetic = [
    '- stage: publish',
    '  jobs:',
    '    - job: publish_vsix',
    '      steps:',
    '        - script: |',
    '            echo "##vso[task.setvariable variable=SignedVsix]${vsixes[0]}"',
    '          displayName: Resolve',
    '        - task: CodeSignValidation@0',
    '          continueOnError: true',
    '          inputs:',
    '            path: $(Pipeline.Workspace)/signed',
    '        - script: |',
    '            cp /tmp/evil.vsix $(SignedVsix)',
    '          displayName: Tamper',
    '        - task: PublishAzureDevOpsExtension@4',
    '          inputs:',
    '            vsixFile: $(SignedVsix)',
    '  ',
  ].join('\n');
  const parsed = parsePipeline(synthetic);
  const pub = parsed.find((s) => s.name === 'publish')!;
  // continueOnError is captured — a non-blocking gate is now visible (and would be rejected).
  const csv = pub.tasks.find((t) => t.id.endsWith('CodeSignValidation@0'))!;
  assert.equal(csv.continueOnError, true, 'a continueOnError: true gate is parsed as non-blocking');
  // Script steps are captured in order with their body — the intervening tamper is detectable.
  const scripts = pub.steps.filter((s) => s.kind === 'script');
  assert.equal(scripts.length, 2, 'both script steps are modeled');
  const tamper = scripts.find((s) => /cp\s+\S+\s+\$\(SignedVsix\)/.test(s.script));
  assert.ok(tamper, 'the tampering script that overwrites $(SignedVsix) is captured');
  const publishTask = pub.tasks.find((t) => t.id.endsWith('PublishAzureDevOpsExtension@4'))!;
  assert.ok(tamper!.index > csv.index && tamper!.index < publishTask.index, 'the tamper step is ordered BETWEEN validation and publication (would be rejected)');
});

test('parsePipeline models artifact-download steps so an intervening DownloadPipelineArtifact / download shortcut is detectable (pass 53 finding #3)', () => {
  const synthetic = [
    '- stage: publish',
    '  jobs:',
    '    - job: publish_vsix',
    '      steps:',
    '        - task: CodeSignValidation@0',
    '          inputs:',
    '            path: $(Pipeline.Workspace)/signed',
    '        - task: DownloadPipelineArtifact@2',
    '          inputs:',
    '            artifact: unsigned',
    '            downloadPath: $(Pipeline.Workspace)/signed',
    '        - download: current',
    '          artifact: unsigned2',
    '          path: $(Pipeline.Workspace)/signed',
    '        - task: PublishAzureDevOpsExtension@4',
    '          inputs:',
    '            vsixFile: $(SignedVsix)',
    '  ',
  ].join('\n');
  const parsed = parsePipeline(synthetic);
  const pub = parsed.find((s) => s.name === 'publish')!;
  // The DownloadPipelineArtifact task is modeled with its downloadPath input.
  const dl = pub.steps.find((s) => s.kind === 'task' && s.id.endsWith('DownloadPipelineArtifact@2'))!;
  assert.ok(dl, 'the DownloadPipelineArtifact task is captured as a step');
  assert.equal(dl.inputs.downloadPath, '$(Pipeline.Workspace)/signed', 'the downloadPath input targeting the signed dir is parsed');
  // The `- download:` shortcut is modeled with its path input.
  const dlShortcut = pub.steps.find((s) => s.kind === 'download')!;
  assert.ok(dlShortcut, 'the download shortcut is captured as a step');
  assert.equal(dlShortcut.inputs.path, '$(Pipeline.Workspace)/signed', 'the download shortcut path targeting the signed dir is parsed');
  // Both are ordered BETWEEN validation and publication (so the guard would reject them).
  const csv = pub.tasks.find((t) => t.id.endsWith('CodeSignValidation@0'))!;
  const publishTask = pub.tasks.find((t) => t.id.endsWith('PublishAzureDevOpsExtension@4'))!;
  assert.ok(dl.index > csv.index && dl.index < publishTask.index, 'the DownloadPipelineArtifact is between validation and publication');
  assert.ok(dlShortcut.index > csv.index && dlShortcut.index < publishTask.index, 'the download shortcut is between validation and publication');
});

test('assertStrictAndCondition (exact) rejects decoy/false conjuncts, and assertJobNotDisabled rejects a disabled job (pass 51 finding #4)', () => {
  const branchEq = "eq(variables['Build.SourceBranch'],variables['PublishBranch'])";
  // A decoy always-TRUE extra conjunct (masking a weakened gate) is rejected in exact mode.
  assert.throws(
    () => assertStrictAndCondition(`and(succeeded(), ${branchEq}, eq('1','1'))`, 'x', [branchEq], true),
    /ONLY the allowed conjuncts|EXACTLY/,
    'an extra decoy conjunct is rejected in exact mode',
  );
  // An always-FALSE extra conjunct (silently disabling the stage) is rejected in exact mode.
  assert.throws(
    () => assertStrictAndCondition(`and(succeeded(), ${branchEq}, eq('a','b'))`, 'x', [branchEq], true),
    /ONLY the allowed conjuncts|EXACTLY/,
    'an always-false decoy conjunct is rejected in exact mode',
  );
  // The exact genuine form passes.
  assertStrictAndCondition(`and(succeeded(), ${branchEq})`, 'x', [branchEq], true);
  // assertJobNotDisabled: a `condition: false` job is rejected; an absent condition passes.
  const disabled: ParsedStage = { name: 's', tasks: [], steps: [], settings: {}, condition: '', dependsOn: [], artifactNames: [], jobArtifacts: {}, jobEnvironments: {}, jobConditions: { j: 'false' } };
  assert.throws(() => assertJobNotDisabled(disabled, 'j', [branchEq]), /condition: false/, 'a condition:false job is rejected');
  const clean: ParsedStage = { name: 's', tasks: [], steps: [], settings: {}, condition: '', dependsOn: [], artifactNames: [], jobArtifacts: {}, jobEnvironments: {}, jobConditions: {} };
  assertJobNotDisabled(clean, 'j', [branchEq]); // no job condition → governed by the stage gate
});

test('parsePipeline captures enabled:false, conditions, dependsOn, and artifact names (pass 47 finding #3)', () => {
  const synthetic = [
    '- stage: publish',
    '  dependsOn: sign',
    '  condition: >-',
    "    and(succeeded(), eq(variables['Build.SourceBranch'], variables['PublishBranch']))",
    '  jobs:',
    '    - job: publish_vsix',
    '      templateContext:',
    '        inputs:',
    '          - input: pipelineArtifact',
    '            artifactName: drop_sign_sign_vsix',
    '      steps:',
    '        - task: CodeSignValidation@0',
    '          enabled: false',
    '          inputs:',
    '            path: x',
    '        - task: PublishAzureDevOpsExtension@4',
    '          inputs:',
    '            connectedServiceName: ADO-Plugin Publishing',
  ].join('\n');
  const parsed = parsePipeline(synthetic);
  const pub = parsed.find((s) => s.name === 'publish')!;
  assert.deepEqual(pub.dependsOn, ['sign'], 'dependsOn is parsed');
  assert.match(pub.condition, /Build\.SourceBranch.*PublishBranch/, 'the folded condition is gathered to one line');
  assert.ok(pub.artifactNames.includes('drop_sign_sign_vsix'), 'the consumed artifact name is captured');
  const csv = pub.tasks.find((t) => t.id.endsWith('CodeSignValidation@0'))!;
  assert.equal(csv.enabled, false, 'a task with enabled: false is parsed as disabled (a disabled gate is detectable)');
  const publishTask = pub.tasks.find((t) => t.id.endsWith('PublishAzureDevOpsExtension@4'))!;
  assert.equal(publishTask.enabled, true, 'a task without enabled: false defaults to enabled');
  assert.equal(publishTask.inputs.connectedServiceName, 'ADO-Plugin Publishing', 'the service connection identity is captured');
});

test('parsePipeline captures a MULTILINE folded task condition and a per-job environment (pass 49 finding #3)', () => {
  const synthetic = [
    '- stage: sign',
    '  jobs:',
    '    - deployment: sign_vsix',
    '      environment: $(SigningEnvironment)',
    '      steps:',
    '        - task: CodeSignValidation@0',
    '          condition: >-',
    '            and(succeeded(),',
    "                eq('false', 'true'))",
    '          inputs:',
    '            path: x',
  ].join('\n');
  const parsed = parsePipeline(synthetic);
  const sign = parsed.find((s) => s.name === 'sign')!;
  const csv = sign.tasks.find((t) => t.id.endsWith('CodeSignValidation@0'))!;
  // The folded (multiline) task condition is gathered to one line (NOT read as the bare `>-`), so a
  // gate-skipping condition is DETECTABLE (non-empty) — the enabled+unconditional gate check would
  // then reject it.
  assert.match(csv.condition, /and\(succeeded\(\),\s*eq\('false',\s*'true'\)\)/, 'the folded task condition is gathered');
  assert.notEqual(csv.condition, '', 'a multiline false task condition is captured (not silently empty)');
  // The deployment job's environment is bound to that job.
  assert.equal(sign.jobEnvironments['sign_vsix'], '$(SigningEnvironment)', 'the per-job environment is captured');
});

test('assertStrictAndCondition rejects negated branch gates (pass 49 finding #3)', () => {
  assert.throws(
    () => assertStrictAndCondition("and(succeeded(), ne(variables['Build.SourceBranch'], variables['PublishBranch']))", 'x'),
    /NEGATED ne/,
    'a ne(...) branch check is rejected',
  );
  assert.throws(
    () => assertStrictAndCondition("and(succeeded(), not(eq(variables['Build.SourceBranch'], variables['PublishBranch'])))", 'x'),
    /wrap the branch eq/,
    'a not(eq(...)) wrapper is rejected',
  );
  // The positive form passes.
  assertStrictAndCondition("and(succeeded(), eq(variables['Build.SourceBranch'], variables['PublishBranch']))", 'x');
});

test('assertStrictAndCondition rejects a DEAD/NESTED branch predicate (semantic, not token, pass 50 finding #1)', () => {
  const branchEq = "eq(variables['Build.SourceBranch'],variables['PublishBranch'])";
  // The branch eq is present as a SUBSTRING but NESTED as an argument to another eq — it does NOT
  // gate the run, so requiring it as a DIRECT conjunct rejects the condition.
  assert.throws(
    () => assertStrictAndCondition("and(succeeded(), eq('x', eq(variables['Build.SourceBranch'], variables['PublishBranch'])))", 'x', [branchEq]),
    /DIRECT conjunct/,
    'a branch eq nested inside another eq is rejected (dead position)',
  );
  // A condition whose ROOT is not `and(...)` (an `or(...)` making the whole thing permissive) is
  // rejected before any conjunct check.
  assert.throws(
    () => assertStrictAndCondition("or(and(succeeded(), eq(variables['Build.SourceBranch'], variables['PublishBranch'])), true)", 'x', [branchEq]),
    /and\(\.\.\.\) gate/,
    'an or(...)-rooted condition is rejected',
  );
  // succeeded() nested (not a direct conjunct) is rejected.
  assert.throws(
    () => assertStrictAndCondition("and(eq('a', succeeded()), " + branchEq + ")", 'x', [branchEq]),
    /succeeded\(\) as a DIRECT conjunct/,
    'a nested succeeded() is rejected',
  );
  // The genuine form (both direct conjuncts) passes.
  assertStrictAndCondition("and(succeeded(), " + branchEq + ")", 'x', [branchEq]);
});

test('parsePipeline SKIPS task-like text inside a YAML block scalar (pass 45 finding #7)', () => {
  // A `- task:` line inside a `script: |` block scalar must NOT be parsed as a real pipeline task;
  // only the genuine `- task:` outside the block scalar counts.
  const synthetic = [
    '- stage: build',
    '  jobs:',
    '    - job: b',
    '      steps:',
    '        - task: RealTask@1',
    '          inputs:',
    '            foo: bar',
    '        - script: |',
    '            echo "installing"',
    '            # the following looks like a task but is shell text inside the block scalar:',
    '            - task: EvilTask@9',
    '              inputs:',
    '                cmd: rm -rf /',
    '        - task: AnotherReal@2',
  ].join('\n');
  const parsed = parsePipeline(synthetic);
  const build = parsed.find((s) => s.name === 'build');
  assert.ok(build, 'the build stage is parsed');
  const ids = build!.tasks.map((t) => t.id);
  assert.deepEqual(ids, ['RealTask@1', 'AnotherReal@2'], 'only real tasks are parsed; the block-scalar EvilTask@9 is skipped');
  assert.ok(!ids.includes('EvilTask@9'), 'task-like text inside a block scalar is not an executable task');
  // The real task's inputs are still parsed; the block-scalar cmd input is not leaked.
  const real = build!.tasks.find((t) => t.id === 'RealTask@1');
  assert.equal(real!.inputs.foo, 'bar', 'the real task inputs are parsed');
});

test('parsePipeline binds each task to its executing JOB; a sibling-job gate is distinguishable (pass 46 finding #3)', () => {
  // Two jobs in one stage: the publishing job lacks the gate; a decoy sibling job has it. A
  // stage-wide search would wrongly find the gate; job-binding must keep them separate.
  const synthetic = [
    '- stage: publish',
    '  jobs:',
    '    - job: decoy',
    '      steps:',
    '        - task: securedevelopmentteam.CodeSignValidation@0',
    '          inputs:',
    '            path: x',
    '    - job: publish_vsix',
    '      steps:',
    '        - task: PublishAzureDevOpsExtension@4',
    '          inputs:',
    '            connectTo: VsTeam',
  ].join('\n');
  const parsed = parsePipeline(synthetic);
  const pub = parsed.find((s) => s.name === 'publish')!;
  const publishTask = pub.tasks.find((t) => t.id.endsWith('PublishAzureDevOpsExtension@4'))!;
  assert.equal(publishTask.job, 'publish_vsix', 'the publish task is bound to its own job');
  const csvInPublishJob = pub.tasks.find((t) => t.job === publishTask.job && t.id.endsWith('CodeSignValidation@0'));
  assert.equal(csvInPublishJob, undefined, 'the CodeSign Validation in a SIBLING job does not count for the publish job (job-bound)');
  const csvAnyStage = pub.tasks.find((t) => t.id.endsWith('CodeSignValidation@0'));
  assert.ok(csvAnyStage && csvAnyStage.job === 'decoy', 'a stage-wide search would wrongly find the decoy-job gate');
});
