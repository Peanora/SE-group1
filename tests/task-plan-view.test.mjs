import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTaskChanges, unavailableDependencies } from '../public/task-plan-view.js';

const task = (id, dependsOn = [], extra = {}) => ({
  id, title: `${id}标题`, description: `${id}说明`, acceptance: [`${id}可验收`],
  dependsOn, requirementIds: ['R-001'], ...extra,
});
const sample = () => [task('A'), task('B', ['A']), task('C', ['A']), task('D', ['B', 'C']), task('E')];

test('任务草稿预览仅比较可编辑内容，忽略依赖和来源排列，不修改输入', () => {
  const saved = sample(); saved[3].requirementIds = ['R-001', 'R-002'];
  const draft = structuredClone(saved);
  draft[3].dependsOn.reverse(); draft[3].requirementIds.reverse();
  draft[0].writePaths = ['src/new.mjs'];
  const before = structuredClone({ saved, draft });
  assert.deepEqual(summarizeTaskChanges(saved, draft), { changed: [], downstreamIds: [], errors: [] });
  const editableFiles = summarizeTaskChanges(saved, draft, { includeWritePaths: true });
  assert.deepEqual(editableFiles.changed.map(item => item.fields.map(field => field.key)), [['writePaths']]);
  assert.deepEqual(editableFiles.downstreamIds, ['B', 'C', 'D']);
  assert.deepEqual({ saved, draft }, before);
});

test('改标题与验收可显示真实前后内容，旧新依赖并集保留被移除连线的下游', () => {
  const saved = sample(), draft = structuredClone(saved);
  draft[0].title = '<script>新标题</script>';
  draft[0].acceptance = ['新的验收条件'];
  draft[1].dependsOn = [];
  const summary = summarizeTaskChanges(saved, draft);
  assert.deepEqual(summary.changed.map(item => item.id), ['A', 'B']);
  assert.deepEqual(summary.changed[0], {
    id: 'A', title: '<script>新标题</script>', fields: [
      { key: 'title', label: '任务标题', before: 'A标题', after: '<script>新标题</script>' },
      { key: 'acceptance', label: '验收条件', before: ['A可验收'], after: ['新的验收条件'] },
    ],
  });
  assert.deepEqual(summary.downstreamIds, ['C', 'D']);
  assert.deepEqual(summary.errors, []);
});

test('下游预览覆盖新增连线且不包含未关联分支', () => {
  const saved = sample(), draft = structuredClone(saved);
  draft[1].dependsOn = ['E'];
  const summary = summarizeTaskChanges(saved, draft);
  assert.deepEqual(summary.changed.map(item => item.id), ['B']);
  assert.deepEqual(summary.downstreamIds, ['D']);
  assert.deepEqual(summary.errors, []);
});

test('新增和删除任务的字段前后值保留，仍校验删除后留下的未知依赖', () => {
  const saved = [task('A'), task('B', ['A'])];
  const draft = [task('B', ['A']), task('C')];
  const summary = summarizeTaskChanges(saved, draft);
  assert.deepEqual(summary.changed.map(item => item.id), ['C', 'A']);
  assert.equal(summary.changed[0].fields[0].before, undefined);
  assert.equal(summary.changed[0].fields[0].after, 'C标题');
  assert.equal(summary.changed[1].fields[0].before, 'A标题');
  assert.equal(summary.changed[1].fields[0].after, undefined);
  assert.deepEqual(summary.downstreamIds, ['B']);
  assert.match(summary.errors.join('\n'), /任务 B.*不存在.*A/);
});

test('空标题描述与验收、未知和重复前置、自依赖均提供可定位提示', () => {
  const draft = [task('A', ['A', 'missing', 'missing'], { title: ' ', description: '', acceptance: [' '] })];
  const errors = summarizeTaskChanges([], draft).errors.join('\n');
  for (const pattern of [/任务 A.*标题/, /任务 A.*描述/, /任务 A.*验收条件/, /任务 A.*自身/, /任务 A.*不存在.*missing/, /任务 A.*重复.*missing/]) assert.match(errors, pattern);
});

test('重复编号、缺失编号与无任务计划不能被预览为有效', () => {
  const duplicate = summarizeTaskChanges([], [task('A'), task('A')]);
  assert.match(duplicate.errors.join('\n'), /编号 A 重复/);
  assert.match(summarizeTaskChanges([], [task('')]).errors.join('\n'), /缺少任务编号/);
  assert.match(summarizeTaskChanges([], []).errors.join('\n'), /至少需要一项任务/);
  assert.match(summarizeTaskChanges([], null).errors.join('\n'), /任务数组/);
  assert.match(summarizeTaskChanges([], [null]).errors.join('\n'), /格式不正确/);
});

test('循环依赖会阻止保存，循环图的前置候选和影响遍历均能结束', () => {
  const cyclic = [task('A', ['C']), task('B', ['A']), task('C', ['B']), task('D')];
  assert.match(summarizeTaskChanges([], cyclic).errors.join('\n'), /循环依赖/);
  assert.deepEqual([...unavailableDependencies(cyclic, 'A')].sort(), ['A', 'B', 'C']);
  const draft = structuredClone(cyclic); draft[0].description = '调整说明';
  assert.deepEqual(summarizeTaskChanges(cyclic, draft).downstreamIds, ['B', 'C']);
});

test('前置任务候选禁用自身和所有传递下游，允许祖先与独立任务', () => {
  assert.deepEqual([...unavailableDependencies(sample(), 'A')].sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual([...unavailableDependencies(sample(), 'B')].sort(), ['B', 'D']);
  assert.deepEqual([...unavailableDependencies(sample(), 'D')], ['D']);
  assert.deepEqual([...unavailableDependencies([], 'new-task')], ['new-task']);
});

test('1000项长依赖链支持完整传递预览，无递归栈限制并拒绝超上限计划', () => {
  const saved = Array.from({ length: 1000 }, (_, index) => task(`T${index}`, index ? [`T${index - 1}`] : []));
  const draft = structuredClone(saved); draft[0].description = '修改起点';
  const summary = summarizeTaskChanges(saved, draft);
  assert.equal(summary.changed.length, 1);
  assert.equal(summary.downstreamIds.length, 999);
  assert.deepEqual(summary.errors, []);
  assert.equal(unavailableDependencies(saved, 'T0').size, 1000);
  assert.match(summarizeTaskChanges(saved, [...draft, task('extra')]).errors.join('\n'), /最多支持1000/);
});

test('与服务端一致忽略字段两端空白，验收条件顺序仍会产生修订', () => {
  const saved = [task('A', [], { acceptance: ['条件一', '条件二'] })], draft = structuredClone(saved);
  draft[0].title = ` ${saved[0].title} `;
  draft[0].description = ` ${saved[0].description} `;
  assert.equal(summarizeTaskChanges(saved, draft).changed.length, 0);
  draft[0].acceptance.reverse();
  assert.deepEqual(summarizeTaskChanges(saved, draft).changed[0].fields.map(item => item.key), ['acceptance']);
});
