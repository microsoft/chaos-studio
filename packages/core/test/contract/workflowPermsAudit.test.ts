import { test } from 'node:test';
import assert from 'node:assert/strict';

import { auditWorkflowPermissions } from '../../src/release/workflowPermsAudit.ts';

test('auditWorkflowPermissions: a top-level contents: write grant is a finding', () => {
  const wf = { name: 'ci.yml', content: 'name: ci\npermissions:\n  contents: write\njobs: {}\n' };
  const { findings } = auditWorkflowPermissions([wf]);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /ci\.yml: grants contents: write/);
});

test('auditWorkflowPermissions: a JOB-level contents: write grant is a finding (overrides read default)', () => {
  const content = [
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    permissions:',
    '      contents: write',
    '    steps: []',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'build.yml', content }]);
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /build\.yml: grants contents: write/);
});

test('auditWorkflowPermissions: write-all (inline) is a finding; read-all and {} are clean', () => {
  const bad = auditWorkflowPermissions([{ name: 'a.yml', content: 'permissions: write-all\n' }]);
  assert.equal(bad.findings.length, 1);
  assert.match(bad.findings[0]!, /write-all/);
  const readAll = auditWorkflowPermissions([{ name: 'b.yml', content: 'permissions: read-all\n' }]);
  assert.deepEqual(readAll.findings, []);
  const none = auditWorkflowPermissions([{ name: 'c.yml', content: 'permissions: {}\n' }]);
  assert.deepEqual(none.findings, []);
});

test('auditWorkflowPermissions: an inline map grant is a finding', () => {
  const wf = { name: 'd.yml', content: 'permissions: { contents: write, id-token: write }\n' };
  const { findings } = auditWorkflowPermissions([wf]);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /contents: write/);
});

test('auditWorkflowPermissions: contents: read and id-token: write are NOT content-write findings', () => {
  const content = 'permissions:\n  contents: read\n  id-token: write\n';
  const { findings } = auditWorkflowPermissions([{ name: 'ok.yml', content }]);
  assert.deepEqual(findings, [], 'id-token: write is not a content-bearing write vector');
});

test('auditWorkflowPermissions: an allowlisted GATED (known-protected environment) content-write reports a NOTE, not a finding', () => {
  const content = [
    'jobs:',
    '  publish:',
    '    environment: release',
    '    permissions:',
    '      contents: write',
    '    steps: []',
  ].join('\n');
  const { findings, notes } = auditWorkflowPermissions([{ name: 'release.yml', content }], {
    allowlistedWriteWorkflows: ['release.yml'],
    protectedEnvironments: ['release'],
  });
  assert.deepEqual(findings, [], 'an allowlisted, known-protected-environment-gated write grant is not a hard finding');
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /release\.yml: grants contents: write in an environment-gated job \(allowlisted/);
});

test('auditWorkflowPermissions: an ARBITRARY (unknown) environment name is NOT treated as protected (pass 43 finding #2)', () => {
  // The job binds an environment, but its name is NOT in the operator-verified protected set,
  // so the write is un-gated and must be a finding even for an allowlisted workflow.
  const content = [
    'jobs:',
    '  publish:',
    '    environment: attacker-made-up-env',
    '    permissions:',
    '      contents: write',
    '    steps: []',
  ].join('\n');
  const { findings, notes } = auditWorkflowPermissions([{ name: 'release.yml', content }], {
    allowlistedWriteWorkflows: ['release.yml'],
    protectedEnvironments: ['release', 'mcp-release', 'pypi'],
  });
  assert.equal(notes.length, 0, 'an arbitrary environment name is not downgraded to a NOTE');
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /NO known-protected environment/);
  // A block-form `environment:` with a `name:` sub-key is read the same way.
  const blockForm = [
    'jobs:',
    '  publish:',
    '    environment:',
    '      name: release',
    '    permissions:',
    '      contents: write',
    '    steps: []',
  ].join('\n');
  const gated = auditWorkflowPermissions([{ name: 'release.yml', content: blockForm }], {
    allowlistedWriteWorkflows: ['release.yml'],
    protectedEnvironments: ['release'],
  });
  assert.deepEqual(gated.findings, [], 'a block-form environment with a protected name is gated');
  assert.equal(gated.notes.length, 1, gated.notes.join(' | '));
});

test('auditWorkflowPermissions: with NO protectedEnvironments set, every content-write is un-gated (fail closed) (pass 43 finding #2)', () => {
  const content = [
    'jobs:',
    '  publish:',
    '    environment: release',
    '    permissions:',
    '      contents: write',
    '    steps: []',
  ].join('\n');
  const { findings, notes } = auditWorkflowPermissions([{ name: 'release.yml', content }], {
    allowlistedWriteWorkflows: ['release.yml'],
  });
  assert.equal(notes.length, 0, 'without a protected set, no environment name is trusted');
  assert.equal(findings.length, 1, findings.join(' | '));
});

test('auditWorkflowPermissions: an allowlisted UNGATED content-write (no environment) is a finding (pass 42 finding #3)', () => {
  // A workflow-LEVEL grant applies to every job and is not environment-gated.
  const wfLevel = auditWorkflowPermissions([{ name: 'release.yml', content: 'permissions:\n  contents: write\n' }], {
    allowlistedWriteWorkflows: ['release.yml'],
    protectedEnvironments: ['release'],
  });
  assert.equal(wfLevel.notes.length, 0, 'an un-gated workflow-level write is not downgraded to a NOTE');
  assert.equal(wfLevel.findings.length, 1, wfLevel.findings.join(' | '));
  assert.match(wfLevel.findings[0]!, /NO known-protected environment/);
  // A JOB grant with no `environment:` sibling is likewise ungated.
  const jobLevel = auditWorkflowPermissions([{
    name: 'release.yml',
    content: ['jobs:', '  publish:', '    permissions:', '      contents: write', '    steps: []'].join('\n'),
  }], { allowlistedWriteWorkflows: ['release.yml'], protectedEnvironments: ['release'] });
  assert.equal(jobLevel.notes.length, 0, 'an un-gated job write is not downgraded to a NOTE');
  assert.equal(jobLevel.findings.length, 1, jobLevel.findings.join(' | '));
  assert.match(jobLevel.findings[0]!, /NO known-protected environment/);
});

test('auditWorkflowPermissions: a reusable-workflow uses: is ALWAYS a finding (even when allowlisted)', () => {
  const content = [
    'jobs:',
    '  call:',
    '    uses: octo/repo/.github/workflows/reusable.yml@main',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'release.yml', content }], {
    allowlistedWriteWorkflows: ['release.yml'],
  });
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /reusable workflow 'octo\/repo\/\.github\/workflows\/reusable\.yml@main'/);
});

test('auditWorkflowPermissions: a local reusable-workflow uses: (./.github/workflows/x.yml) is a finding', () => {
  const content = 'jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n';
  const { findings } = auditWorkflowPermissions([{ name: 'w.yml', content }]);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /reusable workflow '\.\/\.github\/workflows\/x\.yml'/);
});

test('auditWorkflowPermissions: a step-level action uses: (checkout@sha) is NOT a reusable-workflow finding', () => {
  const content = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    '      - uses: actions/setup-node@1a4442ca2d7f5b7b9e4b6c8f7e2d3a4b5c6d7e8f',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 's.yml', content }]);
  assert.deepEqual(findings, [], 'an action reference (repo@sha, not a .yml) is not a reusable workflow');
});

test('auditWorkflowPermissions: a commented-out write grant is ignored', () => {
  const content = 'permissions:\n  contents: read # was write, now read\n# contents: write\n';
  const { findings } = auditWorkflowPermissions([{ name: 'cmt.yml', content }]);
  assert.deepEqual(findings, [], 'a commented write grant is not active');
});

test('auditWorkflowPermissions: the block ends at a dedent (a later contents: write under another key is separate)', () => {
  // The `contents: write` here is NOT under permissions (it is under a made-up sibling key at
  // the same indent as permissions children but after a dedent), so it must not be read as a
  // permission grant.
  const content = [
    'permissions:',
    '  id-token: write',
    'jobs:',
    '  build:',
    '    env:',
    '      contents: write',
    '    steps: []',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'j.yml', content }]);
  assert.deepEqual(findings, [], 'a contents: write under env: is not a permissions grant');
});

test('auditWorkflowPermissions: packages: write is a content-bearing write finding', () => {
  const { findings } = auditWorkflowPermissions([{ name: 'p.yml', content: 'permissions:\n  packages: write\n' }]);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!, /packages: write/);
});

test('auditWorkflowPermissions: a QUOTED permissions key and QUOTED scope key are still audited (pass 41 finding #3)', () => {
  const dq = auditWorkflowPermissions([{ name: 'q.yml', content: '"permissions":\n  "contents": write\n' }]);
  assert.equal(dq.findings.length, 1, dq.findings.join(' | '));
  assert.match(dq.findings[0]!, /contents: write/);
  // A single-quoted inline write-all key is also caught.
  const sq = auditWorkflowPermissions([{ name: 'r.yml', content: "'permissions': write-all\n" }]);
  assert.equal(sq.findings.length, 1);
  assert.match(sq.findings[0]!, /write-all/);
});

test('auditWorkflowPermissions: YAML ANCHOR write-all and ALIAS resolution are audited (pass 41 finding #3)', () => {
  // An anchored inline write-all is caught.
  const anchored = auditWorkflowPermissions([{ name: 'a.yml', content: 'permissions: &perm write-all\n' }]);
  assert.equal(anchored.findings.length, 1, anchored.findings.join(' | '));
  assert.match(anchored.findings[0]!, /write-all/);
  // An alias that resolves to write-all (defined earlier) is caught.
  const aliased = auditWorkflowPermissions([{
    name: 'b.yml',
    content: ['defaults: &perm write-all', 'permissions: *perm'].join('\n'),
  }]);
  assert.ok(aliased.findings.some((f) => /write-all/.test(f)), aliased.findings.join(' | '));
  // An UNRESOLVABLE alias fails closed (a finding), not a silent pass.
  const unresolved = auditWorkflowPermissions([{ name: 'c.yml', content: 'permissions: *missing\n' }]);
  assert.equal(unresolved.findings.length, 1);
  assert.match(unresolved.findings[0]!, /UNRESOLVABLE YAML alias/);
});

test('auditWorkflowPermissions: allowlisting does NOT bless a write-all grant (pass 41 finding #3)', () => {
  const { findings, notes } = auditWorkflowPermissions([{ name: 'release.yml', content: 'permissions: write-all\n' }], {
    allowlistedWriteWorkflows: ['release.yml'],
  });
  assert.equal(notes.length, 0, 'write-all is never downgraded to a NOTE');
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /write-all/);
});

test('auditWorkflowPermissions: a QUOTED reusable-workflow uses: value is a finding (pass 41 finding #3)', () => {
  const content = 'jobs:\n  call:\n    uses: "octo/repo/.github/workflows/reusable.yml@main"\n';
  const { findings } = auditWorkflowPermissions([{ name: 'w.yml', content }]);
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /reusable workflow 'octo\/repo\/\.github\/workflows\/reusable\.yml@main'/);
});

test('auditWorkflowPermissions: a FOLDED-scalar permissions write-all is caught (pass 42 finding #3)', () => {
  const content = ['permissions: >', '  write-all', 'jobs: {}'].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'f.yml', content }]);
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /write-all/);
});

test('auditWorkflowPermissions: a FOLDED-scalar uses: reusable-workflow target is a finding (pass 42 finding #3)', () => {
  const content = ['jobs:', '  call:', '    uses: >', '      ./.github/workflows/reusable.yml'].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'f2.yml', content }]);
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /reusable workflow '\.\/\.github\/workflows\/reusable\.yml'/);
});

test('auditWorkflowPermissions: an ALIASED uses: reusable-workflow target is resolved and flagged (pass 42 finding #3)', () => {
  const content = [
    'anchors:',
    '  wf: &wf ./.github/workflows/reusable.yml',
    'jobs:',
    '  call:',
    '    uses: *wf',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'a.yml', content }]);
  assert.ok(findings.some((f) => /reusable workflow '\.\/\.github\/workflows\/reusable\.yml'/.test(f)), findings.join(' | '));
});

test('auditWorkflowPermissions: an UNRESOLVABLE aliased uses: fails closed (pass 42 finding #3)', () => {
  const content = 'jobs:\n  call:\n    uses: *missing\n';
  const { findings } = auditWorkflowPermissions([{ name: 'u.yml', content }]);
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /UNRESOLVABLE YAML alias \(\*missing\)/);
});

test('auditWorkflowPermissions: a MULTILINE flow-mapping permissions grant is classified (pass 43 finding #2)', () => {
  // A `permissions: {` flow map split across lines must be gathered until the braces balance,
  // not read as an empty `{` that hides the write.
  const content = [
    'permissions: {',
    '  contents: write,',
    '  id-token: write',
    '}',
    'jobs: {}',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'm.yml', content }]);
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /contents: write/);
});

test('auditWorkflowPermissions: a FOLDED-scalar ANCHOR value resolves to write-all (pass 43 finding #2)', () => {
  // The anchor value is a folded block scalar; resolving `*perm` must fold it to `write-all`.
  const content = [
    'defaults: &perm >',
    '  write-all',
    'permissions: *perm',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'f.yml', content }]);
  assert.ok(findings.some((f) => /write-all/.test(f)), findings.join(' | '));
});

test('auditWorkflowPermissions: a BLOCK-MAPPING ANCHOR value resolves to a content-write (pass 43 finding #2)', () => {
  // The anchor value is a block mapping on following lines; resolving `*perm` must re-serialize
  // it to an inline map so the contents: write is classified.
  const content = [
    'defaults: &perm',
    '  contents: write',
    '  id-token: write',
    'permissions: *perm',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'b.yml', content }]);
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /contents: write/);
});

test('auditWorkflowPermissions: an ANCHORED FLOW-MAP value (single + multi-line) resolves to a write (pass 44 finding #2)', () => {
  const single = auditWorkflowPermissions([{
    name: 's.yml',
    content: ['base: &perm { contents: write }', 'permissions: *perm'].join('\n'),
  }]);
  assert.equal(single.findings.length, 1, single.findings.join(' | '));
  assert.match(single.findings[0]!, /contents: write/);
  // A multi-line anchored flow map must be gathered until the braces balance.
  const multi = auditWorkflowPermissions([{
    name: 'm.yml',
    content: ['base: &perm {', '  contents: write,', '  id-token: write', '}', 'permissions: *perm'].join('\n'),
  }]);
  assert.equal(multi.findings.length, 1, multi.findings.join(' | '));
  assert.match(multi.findings[0]!, /contents: write/);
});

test('auditWorkflowPermissions: a FLOW-FORM jobs mapping hiding a content-write is a finding (pass 44 finding #2)', () => {
  // A flow-form job with an inline permissions map — the block scanner cannot see it, so the
  // flow-form scan must catch it (fail closed as un-gated).
  const content = 'jobs: { publish: { environment: release, permissions: { contents: write } } }\n';
  const { findings } = auditWorkflowPermissions([{ name: 'f.yml', content }], {
    allowlistedWriteWorkflows: ['f.yml'],
    protectedEnvironments: ['release'],
  });
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /contents: write/);
  // A flow-form write-all is likewise caught.
  const wa = auditWorkflowPermissions([{ name: 'g.yml', content: 'jobs: { build: { permissions: write-all } }\n' }]);
  assert.ok(wa.findings.some((x) => /write-all/.test(x)), wa.findings.join(' | '));
});

test('auditWorkflowPermissions: an ANCHOR REDEFINITION resolves to the NEAREST PRECEDING definition (pass 44 finding #2)', () => {
  // `&perm` is defined write-all FIRST, aliased, then redefined read-all. A global last-wins map
  // would resolve the alias to the later read-all and MISS the write-all — position-aware
  // resolution must bind the alias to the preceding write-all.
  const content = [
    'a: &perm write-all',
    'permissions: *perm',
    'b: &perm read-all',
  ].join('\n');
  const { findings } = auditWorkflowPermissions([{ name: 'r.yml', content }]);
  assert.ok(findings.some((f) => /write-all/.test(f)), findings.join(' | '));
});

test('auditWorkflowPermissions: an ESCAPED double-quoted permissions key is still audited (pass 44 finding #2)', () => {
  // `"permissio\u006es"` decodes to `permissions`; its contents: write must still be found.
  const content = '"permissio\\u006es":\n  contents: write\n';
  const { findings } = auditWorkflowPermissions([{ name: 'e.yml', content }]);
  assert.equal(findings.length, 1, findings.join(' | '));
  assert.match(findings[0]!, /contents: write/);
});

test('auditWorkflowPermissions: a FLOW-FORM reusable workflow (uses: inside a flow map) is a finding (pass 45 finding #2)', () => {
  const content = 'jobs: { call: { uses: ./.github/workflows/reusable.yml } }\n';
  const { findings } = auditWorkflowPermissions([{ name: 'w.yml', content }]);
  assert.ok(findings.some((f) => /reusable workflow '\.\/\.github\/workflows\/reusable\.yml'/.test(f)), findings.join(' | '));
  // A flow-form uses referencing an org/repo@ref reusable workflow is likewise caught.
  const remote = auditWorkflowPermissions([{ name: 'w2.yml', content: 'jobs: { call: { uses: octo/repo/.github/workflows/r.yml@main } }\n' }]);
  assert.ok(remote.findings.some((f) => /reusable workflow 'octo\/repo\/\.github\/workflows\/r\.yml@main'/.test(f)), remote.findings.join(' | '));
  // A flow-form uses whose value is an UNRESOLVABLE alias fails closed.
  const alias = auditWorkflowPermissions([{ name: 'w3.yml', content: 'jobs: { call: { uses: *missing } }\n' }]);
  assert.ok(alias.findings.some((f) => /UNRESOLVABLE YAML alias \(\*missing\)/.test(f)), alias.findings.join(' | '));
  // A flow-form STEP action (owner/repo@sha, not a .yml) is NOT a reusable-workflow finding.
  const action = auditWorkflowPermissions([{ name: 'w4.yml', content: 'jobs: { build: { steps: [ { uses: actions/checkout@abc123 } ] } }\n' }]);
  assert.deepEqual(action.findings, [], action.findings.join(' | '));
});

test('auditWorkflowPermissions: an ESCAPED permissions KEY inside a FLOW mapping is audited (pass 45 finding #2)', () => {
  // `{ "permission\u0073": write-all }` — the flow-form permissions key is double-quoted and
  // escaped; it must be decoded to `permissions` and its write-all caught.
  const content = 'jobs: { build: { "permission\\u0073": write-all } }\n';
  const { findings } = auditWorkflowPermissions([{ name: 'ef.yml', content }]);
  assert.ok(findings.some((f) => /write-all/.test(f)), findings.join(' | '));
  // An escaped scope key inside a flow permissions map (`{ "content\u0073": write }`) is decoded.
  const scope = auditWorkflowPermissions([{ name: 'ef2.yml', content: 'permissions: { "content\\u0073": write }\n' }]);
  assert.ok(scope.findings.some((f) => /contents: write/.test(f)), scope.findings.join(' | '));
});

test('auditWorkflowPermissions: a YAML NODE TAG on a permissions/uses value is stripped and audited (pass 46 finding #2)', () => {
  // `permissions: !!str write-all` — the `!!str` tag must be stripped so the underlying write-all
  // is classified (not read as the literal `!!str write-all`).
  const tagged = auditWorkflowPermissions([{ name: 't.yml', content: 'permissions: !!str write-all\n' }]);
  assert.ok(tagged.findings.some((f) => /write-all/.test(f)), tagged.findings.join(' | '));
  // A tagged content-write inside a block permissions map.
  const scope = auditWorkflowPermissions([{ name: 't2.yml', content: 'permissions:\n  contents: !!str write\n' }]);
  assert.ok(scope.findings.some((f) => /contents: write/.test(f)), scope.findings.join(' | '));
  // A tagged reusable-workflow uses: target is a finding.
  const uses = auditWorkflowPermissions([{ name: 't3.yml', content: 'jobs:\n  call:\n    uses: !!str ./.github/workflows/reusable.yml\n' }]);
  assert.ok(uses.findings.some((f) => /reusable workflow '\.\/\.github\/workflows\/reusable\.yml'/.test(f)), uses.findings.join(' | '));
});

test('auditWorkflowPermissions: a MERGE KEY splicing a permissions grant is a finding (pass 46 finding #2)', () => {
  // `<<: *defaults` merges the anchor's `permissions: write-all` into the job — invisible to the
  // key-line scans, so the merge-key scan must catch it (fail closed / ungated).
  const writeAll = [
    'defaults: &defaults',
    '  permissions: write-all',
    'jobs:',
    '  build:',
    '    <<: *defaults',
    '    steps: []',
  ].join('\n');
  const wa = auditWorkflowPermissions([{ name: 'mrg.yml', content: writeAll }]);
  assert.ok(wa.findings.some((f) => /write-all/.test(f)), wa.findings.join(' | '));

  // A merge key that splices a NARROW content-write is a finding (ungated — merge gating is not
  // verifiable), even when allowlisted with a protected environment.
  const narrow = [
    'defaults: &defaults',
    '  permissions: { contents: write }',
    'jobs:',
    '  build:',
    '    <<: *defaults',
  ].join('\n');
  const nw = auditWorkflowPermissions([{ name: 'mrg2.yml', content: narrow }], {
    allowlistedWriteWorkflows: ['mrg2.yml'],
    protectedEnvironments: ['release'],
  });
  assert.ok(nw.findings.some((f) => /contents: write/.test(f)), nw.findings.join(' | '));

  // A merge key that splices a reusable-workflow uses: is a finding.
  const usesMerge = [
    'defaults: &defaults',
    '  uses: ./.github/workflows/reusable.yml',
    'jobs:',
    '  call:',
    '    <<: *defaults',
  ].join('\n');
  const um = auditWorkflowPermissions([{ name: 'mrg3.yml', content: usesMerge }]);
  assert.ok(um.findings.some((f) => /reusable workflow '\.\/\.github\/workflows\/reusable\.yml'/.test(f)), um.findings.join(' | '));

  // An UNRESOLVABLE merge alias fails closed.
  const missing = auditWorkflowPermissions([{ name: 'mrg4.yml', content: 'jobs:\n  build:\n    <<: *missing\n' }]);
  assert.ok(missing.findings.some((f) => /UNRESOLVABLE YAML alias/.test(f)), missing.findings.join(' | '));
});

test('auditWorkflowPermissions: an INDENTED SCALAR value, a FLOW EXPLICIT key, and an ANCHORED explicit key are audited (pass 50 finding #2)', () => {
  // An INDENTED PLAIN SCALAR value on the line after `permissions:` (write-all).
  const indScalar = auditWorkflowPermissions([{ name: 'i1.yml', content: 'permissions:\n  write-all\njobs: {}\n' }]);
  assert.ok(indScalar.findings.some((f) => /write-all/.test(f)), indScalar.findings.join(' | '));
  // An INDENTED PLAIN SCALAR scope LEVEL (`contents:` then `write` on the next line).
  const indLevel = auditWorkflowPermissions([{ name: 'i2.yml', content: 'permissions:\n  contents:\n    write\n' }]);
  assert.ok(indLevel.findings.some((f) => /contents: write/.test(f)), indLevel.findings.join(' | '));
  // A FLOW EXPLICIT key inside a permissions flow map (`{ ? contents : write }`).
  const flowExplicit = auditWorkflowPermissions([{ name: 'i3.yml', content: 'permissions: { ? contents : write }\n' }]);
  assert.ok(flowExplicit.findings.some((f) => /contents: write/.test(f)), flowExplicit.findings.join(' | '));
  // A FLOW EXPLICIT permissions key (`{ ? permissions : write-all }`).
  const flowPerms = auditWorkflowPermissions([{ name: 'i4.yml', content: 'jobs: { build: { ? permissions : write-all } }\n' }]);
  assert.ok(flowPerms.findings.some((f) => /write-all/.test(f)), flowPerms.findings.join(' | '));
  // An ANCHORED explicit key (`? &pk permissions`).
  const anchored = auditWorkflowPermissions([{ name: 'i5.yml', content: '? &pk permissions\n: write-all\n' }]);
  assert.ok(anchored.findings.some((f) => /write-all/.test(f)), anchored.findings.join(' | '));
});

test('auditWorkflowPermissions: a TAGGED or ANCHORED permissions key inside a FLOW mapping is audited (pass 51 finding #2)', () => {
  // A FLOW explicit key carrying a TAG (`{ ? !!str permissions : write-all }`) must not evade the
  // flow-key scanner: the `!!str` node property is skipped so `permissions` is still recognized.
  const flowTagged = auditWorkflowPermissions([{ name: 'f1.yml', content: 'jobs: { build: { ? !!str permissions : write-all } }\n' }]);
  assert.ok(flowTagged.findings.some((f) => /write-all/.test(f)), flowTagged.findings.join(' | '));
  // A FLOW explicit key carrying an ANCHOR (`{ ? &pk permissions : write-all }`).
  const flowAnchored = auditWorkflowPermissions([{ name: 'f2.yml', content: 'jobs: { build: { ? &pk permissions : write-all } }\n' }]);
  assert.ok(flowAnchored.findings.some((f) => /write-all/.test(f)), flowAnchored.findings.join(' | '));
  // A TAGGED flow key WITHOUT an explicit `?` (`{ !!str permissions: write-all }`).
  const flowTagNoQ = auditWorkflowPermissions([{ name: 'f3.yml', content: 'permissions: { }\njobs: { build: { !!str permissions: write-all } }\n' }]);
  assert.ok(flowTagNoQ.findings.some((f) => /write-all/.test(f)), flowTagNoQ.findings.join(' | '));
  // A COMBINED tag+anchor flow key (`{ ? !!str &pk permissions : write-all }`).
  const flowBoth = auditWorkflowPermissions([{ name: 'f4.yml', content: 'jobs: { build: { ? !!str &pk permissions : write-all } }\n' }]);
  assert.ok(flowBoth.findings.some((f) => /write-all/.test(f)), flowBoth.findings.join(' | '));
});

test('auditWorkflowPermissions: FAILS CLOSED on advanced YAML nodes the scanner cannot model (pass 52 finding #2)', () => {
  // (1) An ALIAS used as a mapping KEY (`*a:`) — an alias-derived permissions/uses key is invisible
  // to the literal-name scanner, so it fails closed.
  const aliasKey = auditWorkflowPermissions([{ name: 'a1.yml', content: ['anchors: &k permissions', '*k: write-all'].join('\n') }]);
  assert.ok(aliasKey.findings.some((f) => /alias is used as a mapping key/.test(f)), aliasKey.findings.join(' | '));
  // An explicit alias key `? *k` also fails closed.
  const aliasExplicit = auditWorkflowPermissions([{ name: 'a2.yml', content: ['anchors: &k permissions', '? *k', ': write-all'].join('\n') }]);
  assert.ok(aliasExplicit.findings.some((f) => /alias is used as a mapping key/.test(f)), aliasExplicit.findings.join(' | '));
  // (2) A MERGE key whose value is a SEQUENCE (`<<: [*a, *b]`) — a multi-mapping merge the
  // single-alias resolver does not splice — fails closed.
  const mergeSeqFlow = auditWorkflowPermissions([{ name: 'm1.yml', content: ['a: &a { permissions: write-all }', 'b: &b { contents: write }', 'jobs:', '  build:', '    <<: [*a, *b]'].join('\n') }]);
  assert.ok(mergeSeqFlow.findings.some((f) => /merge key '<<:' splices a SEQUENCE/.test(f)), mergeSeqFlow.findings.join(' | '));
  // A BLOCK-sequence merge (`<<:` then `- *a` items) likewise fails closed.
  const mergeSeqBlock = auditWorkflowPermissions([{ name: 'm2.yml', content: ['a: &a { permissions: write-all }', 'jobs:', '  build:', '    <<:', '      - *a'].join('\n') }]);
  assert.ok(mergeSeqBlock.findings.some((f) => /merge key '<<:' splices a block SEQUENCE/.test(f)), mergeSeqBlock.findings.join(' | '));
  // (3) A NON-SCALAR/CUSTOM tag on a permissions/uses value fails closed (a scalar `!!str` tag is
  // still handled and does NOT fail closed).
  const mapTag = auditWorkflowPermissions([{ name: 't1.yml', content: 'permissions: !!map { contents: write }\n' }]);
  assert.ok(mapTag.findings.some((f) => /non-scalar\/custom YAML tag/.test(f)), mapTag.findings.join(' | '));
  const customTagUses = auditWorkflowPermissions([{ name: 't2.yml', content: 'jobs:\n  call:\n    uses: !inline ./.github/workflows/x.yml\n' }]);
  assert.ok(customTagUses.findings.some((f) => /non-scalar\/custom YAML tag/.test(f)), customTagUses.findings.join(' | '));
  // (4) A FLOW SEQUENCE value for a permissions/uses key fails closed.
  const flowSeq = auditWorkflowPermissions([{ name: 's1.yml', content: 'permissions: [contents-write]\n' }]);
  assert.ok(flowSeq.findings.some((f) => /flow SEQUENCE/.test(f)), flowSeq.findings.join(' | '));
  // NEGATIVE: a SINGLE-alias merge (`<<: *a`) and a scalar `!!str` tag are STILL handled (not
  // rejected by the fail-closed detector) — no "fail closed" reason for these.
  const singleMerge = auditWorkflowPermissions([{ name: 'ok1.yml', content: ['defaults: &d { permissions: write-all }', 'jobs:', '  build:', '    <<: *d'].join('\n') }]);
  assert.ok(!singleMerge.findings.some((f) => /fail closed/.test(f)), 'a single-alias merge is resolved, not failed closed');
  assert.ok(singleMerge.findings.some((f) => /write-all/.test(f)), 'the single-alias merge still surfaces the spliced write-all');
  const scalarTag = auditWorkflowPermissions([{ name: 'ok2.yml', content: 'permissions: !!str write-all\n' }]);
  assert.ok(!scalarTag.findings.some((f) => /fail closed/.test(f)), 'a scalar !!str tag is handled, not failed closed');
});

test('auditWorkflowPermissions: TAG-BEFORE-ANCHOR values and MULTILINE flow permission mappings are audited (pass 53 finding #2)', () => {
  // TAG-BEFORE-ANCHOR: a scalar `!!str &a write-all` (tag first, then anchor) must be classified by
  // its underlying scalar, not read past the tag as the literal `&a write-all`.
  const tagThenAnchor = auditWorkflowPermissions([{ name: 'ta1.yml', content: 'permissions: !!str &a write-all\n' }]);
  assert.ok(tagThenAnchor.findings.some((f) => /write-all/.test(f)), tagThenAnchor.findings.join(' | '));
  // ANCHOR-BEFORE-TAG (the reverse order) is likewise resolved.
  const anchorThenTag = auditWorkflowPermissions([{ name: 'ta2.yml', content: 'permissions: &a !!str write-all\n' }]);
  assert.ok(anchorThenTag.findings.some((f) => /write-all/.test(f)), anchorThenTag.findings.join(' | '));
  // A tag-before-anchor NARROW scope level inside a block map.
  const scopeTagAnchor = auditWorkflowPermissions([{ name: 'ta3.yml', content: 'permissions:\n  contents: !!str &lvl write\n' }]);
  assert.ok(scopeTagAnchor.findings.some((f) => /contents: write/.test(f)), scopeTagAnchor.findings.join(' | '));
  // MULTILINE FLOW permissions mapping: the `write-all` value sits on a continuation line inside a
  // flow map — it must be gathered, not read as an empty value.
  const multilineFlow = auditWorkflowPermissions([{ name: 'mf1.yml', content: 'jobs: { build: { permissions:\n  write-all } }\n' }]);
  assert.ok(multilineFlow.findings.some((f) => /write-all/.test(f)), multilineFlow.findings.join(' | '));
  // A multiline flow permissions MAP (`permissions: {` continued) with a nested content-write.
  const multilineFlowMap = auditWorkflowPermissions([{ name: 'mf2.yml', content: 'jobs: { build: { permissions: {\n  contents: write\n} } }\n' }]);
  assert.ok(multilineFlowMap.findings.some((f) => /contents: write/.test(f)), multilineFlowMap.findings.join(' | '));
});

test('auditWorkflowPermissions: an EXPLICIT-KEY grant (? key / : value) is normalized and audited (pass 48 finding #2)', () => {
  // YAML explicit-key syntax `? permissions` / `: write-all` must be normalized to `permissions:
  // write-all` before scanning, else the grant is invisible to the line-oriented `key:` scanner.
  const wa = auditWorkflowPermissions([{ name: 'x1.yml', content: '? permissions\n: write-all\njobs: {}\n' }]);
  assert.ok(wa.findings.some((f) => /write-all/.test(f)), wa.findings.join(' | '));
  // An explicit SCOPE key inside a permissions block.
  const scope = auditWorkflowPermissions([{ name: 'x2.yml', content: 'permissions:\n  ? contents\n  : write\n' }]);
  assert.ok(scope.findings.some((f) => /contents: write/.test(f)), scope.findings.join(' | '));
  // An explicit-key reusable-workflow uses:.
  const uses = auditWorkflowPermissions([{ name: 'x3.yml', content: 'jobs:\n  call:\n    ? uses\n    : ./.github/workflows/x.yml\n' }]);
  assert.ok(uses.findings.some((f) => /reusable workflow '\.\/\.github\/workflows\/x\.yml'/.test(f)), uses.findings.join(' | '));
  // A quoted explicit key is decoded too.
  const quoted = auditWorkflowPermissions([{ name: 'x4.yml', content: '? "permissions"\n: write-all\n' }]);
  assert.ok(quoted.findings.some((f) => /write-all/.test(f)), quoted.findings.join(' | '));
});

test('auditWorkflowPermissions: a MULTILINE double-quoted scalar grant is gathered and audited (pass 48 finding #2)', () => {
  // A double-quoted scalar with a `\`-at-end line continuation folds to `write-all`; the previous
  // scan saw only the unterminated first line and missed it.
  const cont = auditWorkflowPermissions([{ name: 'ml1.yml', content: 'permissions: "write-\\\n  all"\njobs: {}\n' }]);
  assert.ok(cont.findings.some((f) => /write-all/.test(f)), cont.findings.join(' | '));
  // A multiline double-quoted scope LEVEL value (`\`-continuation → the `write` level).
  const level = auditWorkflowPermissions([{ name: 'ml2.yml', content: 'permissions:\n  contents: "wri\\\n  te"\n' }]);
  assert.ok(level.findings.some((f) => /contents: write/.test(f)), level.findings.join(' | '));
});

test('auditWorkflowPermissions: an ESCAPED / MULTILINE / TAGGED uses key or value, and a multiline/tagged explicit key, are audited (pass 49 finding #2)', () => {
  // An ESCAPED block-form `uses` KEY (`"use\u0073":`) is decoded and flagged.
  const escKey = auditWorkflowPermissions([{ name: 'e1.yml', content: 'jobs:\n  call:\n    "use\\u0073": ./.github/workflows/x.yml\n' }]);
  assert.ok(escKey.findings.some((f) => /reusable workflow '\.\/\.github\/workflows\/x\.yml'/.test(f)), escKey.findings.join(' | '));
  // A MULTILINE double-quoted `uses:` value (folded `\`-continuation) is gathered whole.
  const mlUses = auditWorkflowPermissions([{ name: 'e2.yml', content: 'jobs:\n  call:\n    uses: "./.github/workflows/\\\n      x.yml"\n' }]);
  assert.ok(mlUses.findings.some((f) => /reusable workflow '\.\/\.github\/workflows\/x\.yml'/.test(f)), mlUses.findings.join(' | '));
  // A TAGGED explicit permissions key (`? !!str permissions` / `: write-all`).
  const taggedExplicit = auditWorkflowPermissions([{ name: 'e3.yml', content: '? !!str permissions\n: write-all\n' }]);
  assert.ok(taggedExplicit.findings.some((f) => /write-all/.test(f)), taggedExplicit.findings.join(' | '));
  // A MULTILINE explicit key (`?` alone, then the key on the next line).
  const mlExplicit = auditWorkflowPermissions([{ name: 'e4.yml', content: '?\n  permissions\n: write-all\n' }]);
  assert.ok(mlExplicit.findings.some((f) => /write-all/.test(f)), mlExplicit.findings.join(' | '));
});

test('auditWorkflowPermissions: a COMPLEX flow permissions value is split on top-level commas only (pass 46 finding #2)', () => {
  // A flow permissions map must be split on TOP-LEVEL commas so the `contents: write` is classified.
  const content = 'permissions: { checks: read, contents: write, actions: read }\n';
  const { findings } = auditWorkflowPermissions([{ name: 'cx.yml', content }]);
  assert.ok(findings.some((f) => /contents: write/.test(f)), findings.join(' | '));
});

test('auditWorkflowPermissions: an ESCAPED-QUOTE double-quoted key is decoded without mis-splitting (pass 46 finding #2)', () => {
  // A double-quoted key with an escaped quote must be handled by the escape-aware key matcher (the
  // previous `[^"]*` matcher stopped at the escaped quote). The decoded key `perm"issions` is NOT
  // `permissions`, so no grant is found — the matcher must simply not crash or mis-parse.
  const content = '"perm\\"issions":\n  contents: write\n';
  const { findings } = auditWorkflowPermissions([{ name: 'eq.yml', content }]);
  assert.deepEqual(findings, [], findings.join(' | '));
});

test('auditWorkflowPermissions: a long-form \\UXXXXXXXX escaped key is decoded and audited (pass 47 finding #2)', () => {
  // YAML's 8-hex `\U` escape (not just the 4-hex `\u`) must be decoded so an escaped
  // `"permission\U00000073"` key (== permissions) is not missed.
  const blockKey = auditWorkflowPermissions([{ name: 'U1.yml', content: '"permission\\U00000073":\n  contents: write\n' }]);
  assert.ok(blockKey.findings.some((f) => /contents: write/.test(f)), blockKey.findings.join(' | '));
  // The same 8-hex escape inside a FLOW-form permissions key.
  const flowKey = auditWorkflowPermissions([{ name: 'U2.yml', content: 'jobs: { build: { "permission\\U00000073": write-all } }\n' }]);
  assert.ok(flowKey.findings.some((f) => /write-all/.test(f)), flowKey.findings.join(' | '));
});

test('auditWorkflowPermissions: a QUOTED flow value containing a comma is not truncated (pass 47 finding #2)', () => {
  // A flow-form reusable-workflow `uses:` whose QUOTED value contains a comma must be read whole —
  // the previous first-comma bounding truncated it before the `.yml`, letting it evade the audit.
  const uses = auditWorkflowPermissions([{ name: 'q1.yml', content: 'jobs: { call: { uses: "a,b/.github/workflows/r.yml" } }\n' }]);
  assert.ok(uses.findings.some((f) => /reusable workflow 'a,b\/\.github\/workflows\/r\.yml'/.test(f)), uses.findings.join(' | '));
  // A flow-form permissions map whose earlier value is a quoted string containing a comma must not
  // hide a following contents: write.
  const perm = auditWorkflowPermissions([{ name: 'q2.yml', content: 'permissions: { name: "a, b", contents: write }\n' }]);
  assert.ok(perm.findings.some((f) => /contents: write/.test(f)), perm.findings.join(' | '));
});

