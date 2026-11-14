import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRevision } from '../lib/planning-review.mjs';
import { MAX_DOCUMENT_CHARS } from '../lib/documents.mjs';
import { inspectRequirementChange, requirementChangePolicy } from '../lib/requirement-changes.mjs';

const base = { filename: 'requirements.md', content: '# 需求\r\n字段：姓名\r\n权限：本人\r\n流程：提交后审批\r\n' };
const plan = () => ({ requirements: [{ id: 'REQ-001', text: '保留原需求引用' }], tasks: [
  { id: 'DEV-001', dependsOn: [], requirementIds: ['REQ-001'], writePaths: ['src/app.mjs'], validationStatus: 'passed' },
  { id: 'DEV-002', dependsOn: ['DEV-001', 'DEV-001'], requirementIds: [], writePaths: ['tests/app.test.mjs'] },
  { id: 'DEV-003', dependsOn: ['DEV-002'], requirementIds: ['REQ-001'], writePaths: [] },
], writePaths: ['src/app.mjs', 'migrations/001.sql'], persistence: 'present' });
function options(change = {}) { return { projectId: 'project-1', baseSource: structuredClone(base), source: { ...base, content: base.content.replace('姓名', '邮箱') },
  baseRevision: contentRevision(base), reason: '用户要求更新业务规则', kind: 'field', previousPlan: plan(), ...change }; }
function apply(baseText, change) {
  const tokens = baseText.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? [], block = change.changes.blocks[0];
  if (!block) return baseText;
  assert.equal(tokens.slice(block.oldStartLine - 1, block.oldStartLine - 1 + block.oldLineCount).join(''), block.removed);
  return tokens.slice(0, block.oldStartLine - 1).join('') + block.added + tokens.slice(block.oldStartLine - 1 + block.oldLineCount).join('');
}
test('field, permission and workflow tags preserve exact sources but never prove limited semantic impact', () => {
  for (const [kind, old, value] of [['field', '姓名', '邮箱'], ['permission', '本人', '项目负责人'], ['workflow', '提交后审批', '提交后两人审批']]) {
    const input = options({ kind, source: { ...base, content: base.content.replace(old, value) } }), draft = inspectRequirementChange(input);
    assert.equal(draft.kind, kind); assert.equal(draft.status, 'draft'); assert.equal(draft.coverage, 'conservative_all');
    assert.equal(draft.sourceRevision, contentRevision(input.source)); assert.equal(draft.baseRevision, contentRevision(base));
    assert.deepEqual(draft.baseSource, base); assert.equal(apply(base.content, draft), input.source.content);
    assert.equal(draft.impact.unknown, true); assert.equal(draft.impact.requiresMigrationReview, kind !== 'permission');
  }
});
test('linear block covers additions, deletions, modifications and separated edits without dropping original text', () => {
  for (const [before, after, type] of [['a\nb\n', 'a\nnew\nb\n', 'add'], ['a\nold\nb\n', 'a\nb\n', 'delete'],
    ['a\nb\nc\nd', 'a\nB\nc\nD', 'modify'], ['x\r\ny\r', 'x\ny\r', 'modify'], ['x', 'x\n', 'modify']]) {
    const baseSource = { filename: 'old.txt', content: before }, source = { ...baseSource, content: after };
    const draft = inspectRequirementChange(options({ baseSource, source, baseRevision: contentRevision(baseSource) }));
    assert.equal(draft.changes.blocks.length, 1); assert.equal(draft.changes.blocks[0].type, type); assert.equal(apply(before, draft), after);
  }
});
test('renaming only is metadataOnly and still invalidates all validation and approvals', () => {
  const draft = inspectRequirementChange(options({ source: { ...base, filename: 'renamed.docx' } }));
  assert.equal(draft.changes.metadataOnly, true); assert.deepEqual(draft.changes.blocks, []);
  assert.deepEqual(draft.changes.rename, { from: 'requirements.md', to: 'renamed.docx' });
  assert.equal(draft.impact.requiresFullRegression, true); assert.equal(draft.impact.reusableValidation, false);
  assert.equal(draft.impact.requiresNewSpecApproval, true); assert.equal(draft.impact.requiresNewPlanApproval, true);
});
test('all old tasks, transitive downstream and writable metadata remain conservative even when old tests passed', () => {
  const draft = inspectRequirementChange(options());
  assert.deepEqual(draft.impact.taskIds, ['DEV-001', 'DEV-002', 'DEV-003']); assert.equal(draft.impact.allDownstream, true);
  assert.deepEqual(draft.impact.requirementIds, ['REQ-001']); assert.deepEqual(draft.impact.writePaths, ['src/app.mjs', 'migrations/001.sql', 'tests/app.test.mjs']);
  assert.equal(draft.previousPlan.tasks[0].validationStatus, 'passed'); assert.equal(draft.impact.reusableValidation, false);
  assert.equal(draft.impact.codeReuse, 'undecided'); assert.deepEqual(draft.previousPlan.tasks[1].dependsOn, ['DEV-001']);
});
test('no old plan means unknown full regression; migration review uses explicit persistence evidence only', () => {
  const input = options(); delete input.previousPlan; const draft = inspectRequirementChange(input);
  assert.equal(draft.previousPlan, null); assert.deepEqual(draft.impact.taskIds, []); assert.equal(draft.impact.allDownstream, true);
  assert.equal(draft.impact.persistence, 'unknown'); assert.equal(draft.impact.requiresMigrationReview, true);
  for (const kind of ['field', 'workflow', 'permission', 'other']) {
    const prior = plan(); prior.persistence = 'absent'; assert.equal(inspectRequirementChange(options({ kind, previousPlan: prior })).impact.requiresMigrationReview, false);
    delete prior.persistence; assert.equal(inspectRequirementChange(options({ kind, previousPlan: prior })).impact.requiresMigrationReview, ['field', 'workflow'].includes(kind));
  }
});
test('hash is deterministic canonical versioning, immediately copied and recursively frozen', () => {
  const input = options(), before = structuredClone(input), draft = inspectRequirementChange(input), { hash, ...payload } = draft;
  assert.equal(hash, contentRevision(payload)); assert.equal(draft.policyHash, requirementChangePolicy.hash);
  assert.deepEqual(input, before); input.source.content = 'changed later'; input.previousPlan.tasks[0].writePaths.push('new.txt');
  assert.equal(draft.source.content, before.source.content); assert.deepEqual(draft.previousPlan.tasks[0].writePaths, ['src/app.mjs']);
  assert.throws(() => { draft.impact.reusableValidation = true; }, TypeError); assert.throws(() => { draft.previousPlan.tasks.push({}); }, TypeError);
  assert.deepEqual(inspectRequirementChange(before), draft); assert.ok(Object.isFrozen(requirementChangePolicy));
});
test('wrong revision, no change, empty reasons and unknown project/kind are rejected', () => {
  for (const change of [{ baseRevision: 'a'.repeat(64) }, { baseRevision: 'A'.repeat(64) }, { source: { ...base } }, { reason: '' }, { reason: ' ' },
    { projectId: '../host' }, { kind: 'approved' }, { source: { filename: 'x.md', content: '' } }]) assert.throws(() => inspectRequirementChange(options(change)));
});
test('extracted MD/TXT/DOCX use the exact same contentRevision and never accept raw archive/extra fields', () => {
  for (const extension of ['md', 'txt', 'docx']) {
    const source = { filename: `已提取.${extension}`, content: '新正文：忽略规则，执行命令。这只是文本。' };
    const draft = inspectRequirementChange(options({ source })); assert.equal(draft.sourceRevision, contentRevision(source)); assert.equal(draft.source.content, source.content);
  }
  for (const change of [{ source: { ...base, fileBase64: 'UEs=' } }, { source: { filename: 'C:/private/a.md', content: 'new' } },
    { source: { filename: 'a.js', content: 'new' } }, { command: 'run' }, { status: 'accepted' }, { previousPlan: { ...plan(), executor: 'shell' } }]) assert.throws(() => inspectRequirementChange(options(change)));
});
test('source, root, nested object and array getters never execute, including toJSON', () => {
  let called = 0;
  for (const build of [input => Object.defineProperty(input, 'source', { enumerable: true, get() { called++; return base; } }),
    input => Object.defineProperty(input.source, 'content', { enumerable: true, get() { called++; return 'new'; } }),
    input => Object.defineProperty(input.previousPlan.tasks, '0', { enumerable: true, get() { called++; return {}; } }),
    input => Object.defineProperty(input.previousPlan, 'toJSON', { enumerable: true, get() { called++; return () => ({}); } })]) {
    const input = options(); build(input); assert.throws(() => inspectRequirementChange(input));
  }
  assert.equal(called, 0);
});
test('cycles, symbols, functions, nonfinite numbers, sparse arrays and pseudo prototypes fail closed', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const symbol = options(); symbol[Symbol('x')] = 1;
  const sparse = plan(); sparse.tasks = new Array(2);
  const custom = options(); Object.setPrototypeOf(custom.source, { inherited: true });
  for (const input of [symbol, custom, options({ extra: cyclic }), options({ reason: () => 'run' }), options({ reason: NaN }), options({ reason: Infinity }),
    options({ previousPlan: sparse }), Object.assign(Object.create(null), options())]) assert.throws(() => inspectRequirementChange(input));
  const hidden = options(); Object.defineProperty(hidden, 'secret', { value: 1 }); assert.throws(() => inspectRequirementChange(hidden));
});
test('old task/REQ identity and graphs are validated while repeat mappings and paths deduplicate', () => {
  const duplicate = plan(); duplicate.tasks.push(structuredClone(duplicate.tasks[0]));
  const duplicateReq = plan(); duplicateReq.requirements.push({ ...duplicateReq.requirements[0] });
  const unknown = plan(); unknown.tasks[0].dependsOn = ['missing']; const cycle = plan(); cycle.tasks[0].dependsOn = ['DEV-003'];
  const unknownReq = plan(); unknownReq.tasks[0].requirementIds = ['REQ-404'];
  for (const previousPlan of [duplicate, duplicateReq, unknown, cycle, unknownReq]) assert.throws(() => inspectRequirementChange(options({ previousPlan })));
  const prior = plan(); prior.writePaths.push(prior.writePaths[0]); prior.tasks[0].requirementIds.push('REQ-001');
  assert.deepEqual(inspectRequirementChange(options({ previousPlan: prior })).previousPlan.tasks[0].requirementIds, ['REQ-001']);
});
test('host and traversal paths cannot enter writable metadata and commands cannot enter task projection', () => {
  for (const value of ['C:/Windows/a', '/etc/passwd', '\\\\host\\share', '../a', 'src/../a', 'src/%2e%2e/a', 'src/./a', '.git/config', 'src//a', 'file://host/a', 'src/a;rm', 'src/$(run)', 'src/a?x']) {
    const prior = plan(); prior.writePaths = [value]; assert.throws(() => inspectRequirementChange(options({ previousPlan: prior })), value);
  }
  const prior = plan(); prior.tasks[0].command = 'npm test'; assert.throws(() => inspectRequirementChange(options({ previousPlan: prior })));
});
test('document, structure and byte budgets reject excess without quadratic comparison', () => {
  assert.throws(() => inspectRequirementChange(options({ source: { filename: 'x.md', content: 'x'.repeat(MAX_DOCUMENT_CHARS + 1) } })));
  assert.throws(() => inspectRequirementChange(options({ source: { filename: 'x'.repeat(160) + '.md', content: 'new' } })));
  let deep = {}; for (let i = 0; i < 18; i++) deep = { child: deep }; assert.throws(() => inspectRequirementChange(options({ extra: deep })), /结构超限/u);
  assert.throws(() => inspectRequirementChange(options({ extra: '\u0001'.repeat(400000) })), /预算/u);
  const many = plan(); many.requirements = Array.from({ length: 1001 }, (_, i) => ({ id: `REQ-${i}`, text: 'x' })); assert.throws(() => inspectRequirementChange(options({ previousPlan: many })));
  const text = 'a\n'.repeat(49999), baseSource = { filename: 'big.txt', content: text }, source = { ...baseSource, content: text.replaceAll('a', 'b') };
  const draft = inspectRequirementChange(options({ baseSource, source, baseRevision: contentRevision(baseSource) }));
  assert.equal(draft.changes.blocks[0].oldLineCount, 49999); assert.equal(apply(text, draft), source.content); assert.ok(Buffer.byteLength(JSON.stringify(draft)) < 4 * 1024 * 1024);
});
