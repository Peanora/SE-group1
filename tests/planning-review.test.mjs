import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRevision, preparePlanningSpec, validatePlanningSpec, validatePlanningTasks, planningRevision } from '../lib/planning-review.mjs';
import { analyzeRequirements, generateTasks } from '../lib/planner.mjs';

const source = '# 图书管理\n\n- 用户可以搜索图书。\n- 管理员可以维护馆藏。';
const spec = () => analyzeRequirements(source, '图书管理');

test('内容版本稳定且包含问题答复、架构和规格绑定', () => {
  assert.equal(contentRevision({ a: 1, b: { c: 2, d: 3 } }), contentRevision({ b: { d: 3, c: 2 }, a: 1 }));
  const initial = preparePlanningSpec(spec(), source);
  const answer = { [initial.specQuestions[0].id]: '使用网页' };
  const revised = preparePlanningSpec(initial.spec, source, initial.specQuestions, answer);
  assert.notEqual(revised.specRevision, initial.specRevision);
  assert.equal(initial.specQuestions[0].answer, '');
  assert.deepEqual(revised.spec.clarifications, revised.specQuestions);
  const run = { specRevision: revised.specRevision, tasks: generateTasks(revised.spec), artifacts: [{ name: 'architecture.md', content: '架构A' }] };
  const hash = planningRevision(run);
  assert.notEqual(planningRevision({ ...run, specRevision: initial.specRevision }), hash);
  assert.notEqual(planningRevision({ ...run, artifacts: [{ name: 'architecture.md', content: '架构B' }] }), hash);
});

test('规格校验拒绝伪造引用、重复ID、空描述/验收及非法字符串数组', () => {
  const original = spec();
  const bad = change => ({ ...original, ...change });
  const badRequirement = change => bad({ requirements: [{ ...original.requirements[0], ...change }] });
  assert.throws(() => validatePlanningSpec(badRequirement({ sourceQuote: '不存在于需求中' }), source), { status: 400 });
  assert.throws(() => validatePlanningSpec(bad({ requirements: [original.requirements[0], original.requirements[0]] }), source), { status: 400 });
  assert.throws(() => validatePlanningSpec(badRequirement({ description: ' ' }), source), { status: 400 });
  assert.throws(() => validatePlanningSpec(badRequirement({ acceptance: [' '] }), source), { status: 400 });
  assert.throws(() => validatePlanningSpec(bad({ goals: [12] }), source), { status: 400 });
  assert.throws(() => validatePlanningSpec(bad({ stack: { frontend: 'HTML' } }), source), { status: 400 });
  const withExtra = { ...original, businessContext: { owner: '小组' } };
  assert.deepEqual(validatePlanningSpec(withExtra, source).businessContext, withExtra.businessContext);
});

test('问题编号由服务生成，客户端clarifications不能伪造答复或解除阻塞', () => {
  const initial = preparePlanningSpec(spec(), source);
  const fake = { ...initial.spec, clarifications: initial.specQuestions.map(item => ({ ...item, answer: '伪造', blocking: false })) };
  const next = preparePlanningSpec(fake, source, initial.specQuestions);
  assert.equal(next.specRevision, initial.specRevision);
  assert.ok(next.specQuestions.every(item => item.blocking && item.answer === ''));
  assert.throws(() => preparePlanningSpec(initial.spec, source, initial.specQuestions, { 'Q-999': '未知答复' }), { status: 400 });
  assert.throws(() => preparePlanningSpec(initial.spec, source, initial.specQuestions, { 'Q-001': 1 }), { status: 400 });
  assert.throws(() => preparePlanningSpec(initial.spec, source, initial.specQuestions, { 'Q-001': 'x'.repeat(5001) }), { status: 400 });
  const changed = preparePlanningSpec({ ...initial.spec, questions: ['新增问题', initial.spec.questions[0]] }, source, initial.specQuestions);
  assert.equal(changed.specQuestions[1].id, initial.specQuestions[0].id);
  assert.notEqual(changed.specQuestions[0].id, changed.specQuestions[1].id);
});

test('任务不仅校验图，还校验完整需求覆盖与可验收内容', () => {
  const s = spec();
  const tasks = generateTasks(s);
  assert.deepEqual(validatePlanningTasks(s, tasks), tasks);
  assert.throws(() => validatePlanningTasks(s, tasks.map(item => ({ ...item, requirementIds: [] }))), { status: 400 });
  assert.throws(() => validatePlanningTasks(s, tasks.map((item, index) => index ? item : { ...item, requirementIds: ['unknown'] })), { status: 400 });
  assert.throws(() => validatePlanningTasks(s, tasks.map((item, index) => index ? item : { ...item, acceptance: [] })), { status: 400 });
  assert.throws(() => validatePlanningTasks(s, tasks.map((item, index) => index ? item : { ...item, dependsOn: [item.id] })), { status: 400 });
});
