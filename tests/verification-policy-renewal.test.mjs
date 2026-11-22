import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createVerificationPlanningService } from '../lib/verification-planning-service.mjs';
import { createPlannedExecutionService } from '../lib/planned-execution-service.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks } from '../lib/engineering-planner.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';

const ids = { projectId: 'renewal-project', runId: 'renewal-run' };
const cfg = { baseUrl: 'https://policy-renewal-fixture.invalid', model: 'fixture', apiKey: 'synthetic-fixture-only' };
const source = { filename: 'fixture.md', content: '用户读取资源列表。' };
const archivedPolicy = 'a'.repeat(64), archivedManifest = 'b'.repeat(64);
const approvedCommit = 'd'.repeat(40);
const code = value => error => error.code === value;
const sourceMetadata = { sourceExecutionId: 'source-execution', sourceCommit: approvedCommit, sourceRecordHash: 'e'.repeat(64), sourceManifestHash: archivedManifest };

function planning() {
  const spec = { title: '资源系统', summary: source.content, goals: ['读取'], roles: [], constraints: [], assumptions: [], questions: [],
    acceptanceScenarios: ['返回资源'], stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' },
    requirements: [{ id: 'R1', title: '读取', description: source.content, sourceQuote: source.content, acceptance: ['返回资源列表'] }] };
  const specRevision = contentRevision(spec);
  const engineeringPlan = validateEngineeringPlan({ spec, binding: { ...ids, specRevision }, proposal: { version: 1, title: '资源', summary: '已确认接口', entities: [],
    routes: [{ id: 'read', method: 'GET', path: '/resources', roles: [], request: '没有正文', response: '资源集合', errors: [], requirementIds: ['R1'] }],
    views: [{ id: 'home', path: '/', title: '资源', requirementIds: ['R1'], selectors: [{ testId: 'resources', role: 'list' }] }],
    tasks: [{ id: 'dev', title: '读取', description: '实现接口', requirementIds: ['R1'], dependsOn: [], writePaths: ['src/app.mjs'], inputs: ['规格'], outputs: ['接口'], acceptance: ['列表可读'] }] } });
  const run = { id: ids.runId, projectId: ids.projectId, workflowVersion: 2, sourceSnapshot: source, sourceRevision: contentRevision(source), sourceGeneration: 0,
    status: 'succeeded', stages: [], spec, specRevision, specQuestions: [], engineeringPlan, tasks: engineeringTasks(engineeringPlan),
    artifacts: [{ name: 'architecture.md', content: '资源' }], review: { passed: true, issues: [] }, approvals: { spec: { revision: specRevision } } };
  run.planRevision = planningRevision(run); run.approvals.plan = { revision: run.planRevision, specRevision };
  return { project: { id: ids.projectId, source, currentSourceRevision: run.sourceRevision, sourceGeneration: 0 }, run };
}

const proposal = {
  version: 1, id: 'resources', name: '资源验收', sessions: [],
  steps: [{ id: 'read', type: 'request', requirementIds: ['R1'], dependsOn: [],
    request: { id: 'get', method: 'GET', path: '/resources', assertions: [{ id: 'status', op: 'status', value: 200 }] } }],
  browser: { version: 1, sessions: ['visitor'], steps: [
    { id: 'home', session: 'visitor', requirementIds: ['R1'], op: 'goto', path: '/' },
    { id: 'list', session: 'visitor', requirementIds: ['R1'], op: 'visible', testId: 'resources', value: true },
  ] },
};

async function fixture(t, frozen = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tf-policy-renewal-test-'));
  const rootDir = path.join(directory, 'verification'), data = planning(), opened = [];
  const open = async () => {
    const service = await createVerificationPlanningService({ rootDir, getPlanning: () => data, getPlanningSync: () => data, config: cfg });
    opened.push(service); return service;
  };
  t.after(async () => {
    for (const service of opened.reverse()) await service.shutdown();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('tf-policy-renewal-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const old = await open();
  const { capabilities } = await old.list(ids);
  const { proposal: historical } = await old.importDefinition({ ...ids, proposal, contractRevision: capabilities.contractRevision, feedback: '核对旧清单' });
  const proof = { ...ids, proposalId: historical.id, revision: historical.revision };
  await old.approve({ ...proof, feedback: '旧验收规则下批准' });
  if (frozen) await old.withApprovedExecution(proof, async () => ({ terminationConfirmed: true, status: 'failed' }));
  await old.shutdown();
  // Only this isolated synthetic fixture simulates the prior revision and
  // manifest digest. The production path never writes historical rows.
  const db = new DatabaseSync(path.join(rootDir, 'verification.sqlite'));
  let archived, freeze;
  try {
    const row = db.prepare('SELECT * FROM proposals WHERE id=?').get(proof.proposalId);
    const snapshot = JSON.parse(row.snapshot), history = JSON.parse(row.history), approval = JSON.parse(row.approval);
    const savedDefinition = JSON.parse(row.proposal);
    snapshot.binding.policyHash = archivedPolicy;
    snapshot.key = contentRevision(snapshot.binding);
    const revision = contentRevision({ proposal: savedDefinition, binding: snapshot.binding, policyHash: archivedPolicy });
    approval.revision = revision;
    for (const entry of history) { entry.revision = revision; entry.manifestHash = archivedManifest; }
    db.prepare('UPDATE proposals SET context_key=?,snapshot=?,revision=?,manifest_hash=?,approval=?,history=? WHERE id=?')
      .run(snapshot.key, JSON.stringify(snapshot), revision, archivedManifest, JSON.stringify(approval), JSON.stringify(history), row.id);
    db.prepare('UPDATE execution_freezes SET context_key=?,revision=?,manifest_hash=? WHERE proposal_id=?').run(snapshot.key, revision, archivedManifest, row.id);
    archived = db.prepare('SELECT * FROM proposals WHERE id=?').get(row.id);
    freeze = db.prepare('SELECT * FROM execution_freezes WHERE proposal_id=?').get(row.id);
  } finally { db.close(); }
  const service = await open();
  const query = () => {
    const read = new DatabaseSync(path.join(rootDir, 'verification.sqlite'), { readOnly: true });
    try { return { archived: read.prepare('SELECT * FROM proposals WHERE id=?').get(archived.id), freeze: read.prepare('SELECT * FROM execution_freezes WHERE proposal_id=?').get(archived.id) }; }
    finally { read.close(); }
  };
  const renew = async () => {
    const { capabilities } = await service.list(ids);
    return { ...ids, proposalId: archived.id, revision: archived.revision, contractRevision: capabilities.contractRevision,
      ...sourceMetadata, feedback: '新验收规则下续认完全相同的测试' };
  };
  return { service, data, archived, freeze, query, renew, directory, opened };
}

test('policy renewal preserves exact frozen assertions and requires its own approval and historical source', async t => {
  const f = await fixture(t);
  const input = await f.renew();
  const old = (await f.service.list(ids)).proposals.find(item => item.id === f.archived.id);
  assert.equal(old.current, false);
  await assert.rejects(f.service.importDefinition({ ...ids, proposal, contractRevision: input.contractRevision, feedback: '尝试绕开冻结' }), code('definition_frozen'));
  await assert.rejects(f.service.renewPolicy({ ...input, sourceManifestHash: 'f'.repeat(64) }), code('policy_renewal_changed'));
  const first = await f.service.renewPolicy(input), draft = first.proposal;
  assert.equal(first.created, true);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.approved, false);
  assert.equal(draft.actions.canApprove, true);
  assert.equal(draft.actions.canRevise, false);
  assert.deepEqual(draft.proposal, JSON.parse(f.archived.proposal));
  assert.notEqual(draft.manifestHash, f.archived.manifest_hash);
  assert.equal(draft.policyRenewal.sourceExecutionId, sourceMetadata.sourceExecutionId);
  assert.equal((await f.service.renewPolicy(input)).proposal.id, draft.id);
  const corrected = (await f.service.renewPolicy({ ...input, sourceExecutionId: 'distinct-stopped-source', sourceRecordHash: '1'.repeat(64) })).proposal;
  assert.notEqual(corrected.id, draft.id);
  assert.notEqual(corrected.revision, draft.revision);
  const edit = { ...ids, proposalId: draft.id, revision: draft.revision, feedback: '单独审批新规则' };
  const repairProof = { ...ids, proposalId: draft.id, revision: draft.revision, sourceProposalId: f.archived.id, sourceRevision: f.archived.revision, ...sourceMetadata };
  assert.throws(() => f.service.assertPolicyRenewal(repairProof), code('approval_required'));
  await assert.rejects(f.service.revise({ ...edit, proposal: { ...proposal, name: '尝试改变清单' } }), code('definition_frozen'));
  await f.service.approve(edit);
  assert.equal(f.service.assertPolicyRenewal(repairProof), true);
  assert.throws(() => f.service.assertPolicyRenewal({ ...repairProof, sourceRecordHash: '2'.repeat(64) }), code('policy_renewal_changed'));
  assert.throws(() => f.service.assertPolicyRenewal({ ...repairProof, sourceExecutionId: 'other-source' }), code('policy_renewal_changed'));
  assert.throws(() => f.service.assertApprovedDefinition({ ...ids, proposalId: draft.id, revision: draft.revision }), code('policy_renewal_repair_required'));
  await assert.rejects(f.service.approve({ ...edit, proposalId: corrected.id, revision: corrected.revision }), code('policy_renewal_unavailable'));
  assert.deepEqual(f.query(), { archived: f.archived, freeze: f.freeze });

  const planned = await createPlannedExecutionService({ rootDir: path.join(f.directory, 'planned'), getPlanningSync: () => f.data,
    verificationService: f.service, config: cfg, executable: process.execPath, withCheckpoint: (_id, work) => work(),
    dependencies: { startExecution: () => assert.fail('renewal cannot start the runner without the bound source') } });
  f.opened.push(planned);
  const view = await planned.list(ids);
  assert.equal(view.capabilities.canStart, false);
  assert.deepEqual(view.capabilities.repairOnlyProposalIds, [draft.id]);
  await assert.rejects(planned.start({ ...ids, proposalId: draft.id, revision: draft.revision, contractRevision: view.capabilities.contractRevision }), code('policy_renewal_repair_required'));
  const request = { ...ids, executionId: 'not-owned', contractRevision: view.capabilities.contractRevision };
  await assert.rejects(planned.repair({ ...request, renewedDefinition: { proposalId: draft.id, revision: draft.revision, reportPath: 'evil' } }), code('invalid_input'));
  await assert.rejects(planned.repair({ ...request, renewedDefinition: { proposalId: draft.id, revision: draft.revision } }), code('not_found'));
  assert.deepEqual((await planned.list(ids)).executions, []);
});

test('unfrozen and changed planning cannot renew a historical definition', async t => {
  const f = await fixture(t, false);
  const input = await f.renew();
  await assert.rejects(f.service.renewPolicy(input), code('policy_renewal_unavailable'));
  f.data.run.sourceSuperseded = true;
  await assert.rejects(f.service.renewPolicy(input), code('stale_planning'));
  assert.deepEqual(f.query(), { archived: f.archived, freeze: undefined });
});
