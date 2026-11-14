import { contentRevision } from './planning-review.mjs';
import { MAX_DOCUMENT_CHARS } from './documents.mjs';
import { validateTaskGraph } from './planner.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_requirement_change' }); };
const need = (value, message) => { if (!value) fail(message); };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, REQ = /^REQ-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, HASH = /^[a-f0-9]{64}$/u;
const INPUT_BYTES = 2 * 1024 * 1024, OUTPUT_BYTES = 4 * 1024 * 1024;
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const policy = { version: 'requirement-change-v1', maxDocumentChars: MAX_DOCUMENT_CHARS, inputBytes: INPUT_BYTES, outputBytes: OUTPUT_BYTES,
  maxNodes: 40000, maxDepth: 16, maxItems: 2000, maxRequirements: 1000, maxTasks: 1000,
  comparison: 'exact-lines-common-prefix-suffix', coverage: 'conservative_all', reusableValidation: false, approvals: 'new_spec_and_plan', migration: 'field_or_workflow_unless_persistence_absent' };
export const requirementChangePolicy = freeze({ ...policy, hash: contentRevision(policy) });

// Copy descriptors before schema validation; no input getter/toJSON is invoked.
function copyData(input) {
  let nodes = 0, bytes = 0;
  const active = new Set();
  const add = value => { bytes += value; need(bytes <= INPUT_BYTES, '变更输入超过2MiB预算。'); };
  function visit(value, depth) {
    need(++nodes <= policy.maxNodes && depth <= policy.maxDepth, '变更输入结构超限。');
    if (value === null || typeof value === 'boolean') { add(5); return value; }
    if (typeof value === 'string') { need(value.isWellFormed(), '文本包含无效Unicode。'); add(Buffer.byteLength(value) + 2); return value; }
    if (typeof value === 'number') { need(Number.isFinite(value), '输入不能含非有限数字。'); add(24); return value; }
    need(value && typeof value === 'object' && !active.has(value), '仅接受无循环的纯JSON数据。');
    const array = Array.isArray(value);
    need(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype), '输入不能含伪原型或类实例。');
    const keys = Reflect.ownKeys(value); need(keys.length <= policy.maxNodes, '输入属性数量超限。');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = array ? descriptors.length?.value : undefined;
    if (array) need(Number.isInteger(length) && length <= policy.maxItems && keys.length === length + 1, '数组必须稠密且有界。');
    active.add(value); add(2); const result = array ? [] : {};
    for (const key of keys) {
      need(typeof key === 'string', '输入不能包含符号属性。');
      if (array && key === 'length') continue;
      const field = descriptors[key];
      need(field.enumerable && Object.hasOwn(field, 'value') && key !== '__proto__', '输入只能包含自有可枚举数据属性。');
      if (array) need(/^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < length, '数组包含额外属性。');
      add(Buffer.byteLength(key) + 4); Object.defineProperty(result, key, { value: visit(field.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    active.delete(value); return result;
  }
  const result = visit(input, 0);
  need(Buffer.byteLength(JSON.stringify(result)) <= INPUT_BYTES, '变更输入编码后超出预算。'); return result;
}
function object(value, required, optional = []) {
  need(value && typeof value === 'object' && !Array.isArray(value), '字段必须是纯数据对象。');
  need(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), '输入字段缺失或含未授权额外字段。');
}
function text(value, maximum, label) { need(typeof value === 'string' && value.trim() && value.length <= maximum && !value.includes('\0'), `${label}必须是有界非空文本。`); return value; }
function identifier(value, requirement = false) { need(typeof value === 'string' && (requirement ? REQ : ID).test(value), '需求或任务编号格式无效。'); return value; }
function sourceData(value) {
  object(value, ['filename', 'content']);
  text(value.filename, 160, '文件名'); need(!/[\\/:\x00-\x1f\x7f]/u.test(value.filename) && value.filename === value.filename.trim()
    && /\.(?:md|txt|docx)$/iu.test(value.filename), '仅接受已提取的MD/TXT/DOCX基本文件名。');
  text(value.content, MAX_DOCUMENT_CHARS, '需求正文'); return value;
}
function list(value, maximum = policy.maxItems) { need(Array.isArray(value) && value.length <= maximum, '列表缺失或超限。'); return value; }
function unique(values) { return [...new Set(values)]; }
function relativePath(value) {
  text(value, 240, '仓库相对路径');
  need(/^[\p{L}\p{N}._/-]+$/u.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'
    && part !== '.git' && !/[. ]$/u.test(part)), '不接受宿主、遍历或非规范仓库路径。'); return value;
}
function planData(value) {
  if (value === undefined) return null;
  object(value, ['requirements', 'tasks', 'writePaths'], ['persistence']);
  const requirements = list(value.requirements, policy.maxRequirements).map(item => { object(item, ['id', 'text']); return { id: identifier(item.id, true), text: text(item.text, 5000, '旧需求') }; });
  const requirementIds = new Set(requirements.map(item => item.id)); need(requirementIds.size === requirements.length, '旧需求编号重复。');
  const tasks = list(value.tasks, policy.maxTasks).map(item => {
    object(item, ['id', 'dependsOn', 'requirementIds', 'writePaths'], ['validationStatus']);
    const dependsOn = unique(list(item.dependsOn).map(id => identifier(id))), ids = unique(list(item.requirementIds).map(id => identifier(id, true)));
    need(ids.every(id => requirementIds.has(id)), '任务引用了未知需求。');
    const status = item.validationStatus ?? 'unknown'; need(['unknown', 'not_run', 'passed', 'failed'].includes(status), '旧验证状态无效。');
    return { id: identifier(item.id), dependsOn, requirementIds: ids, writePaths: unique(list(item.writePaths).map(relativePath)), validationStatus: status };
  });
  need(new Set(tasks.map(item => item.id)).size === tasks.length, '旧任务编号重复。');
  if (tasks.length) { try { validateTaskGraph(tasks); } catch { fail('旧任务依赖包含未知引用、自环或循环。'); } }
  const persistence = value.persistence ?? 'unknown'; need(['present', 'absent', 'unknown'].includes(persistence), '持久化说明无效。');
  return { requirements, tasks, writePaths: unique(list(value.writePaths).map(relativePath)), persistence };
}
// Each token retains its original LF/CRLF/CR terminator so applying the block is lossless.
function lines(value) { return value.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? []; }
function compare(before, after) {
  const old = lines(before), next = lines(after); let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const removed = old.slice(prefix, old.length - suffix).join(''), added = next.slice(prefix, next.length - suffix).join('');
  return removed || added ? [{ type: !removed ? 'add' : !added ? 'delete' : 'modify', oldStartLine: prefix + 1, newStartLine: prefix + 1,
    oldLineCount: old.length - prefix - suffix, newLineCount: next.length - prefix - suffix, removed, added }] : [];
}

/** Pure draft only: no approval, state mutation, code execution or inherited validation. */
export function inspectRequirementChange(input) {
  const data = copyData(input); object(data, ['projectId', 'baseSource', 'source', 'baseRevision', 'reason', 'kind'], ['previousPlan']);
  const projectId = identifier(data.projectId), baseSource = sourceData(data.baseSource), source = sourceData(data.source);
  need(typeof data.baseRevision === 'string' && HASH.test(data.baseRevision) && data.baseRevision === contentRevision(baseSource), '旧需求版本已变化或不匹配。');
  const reason = text(data.reason, 5000, '变更原因'); need(['field', 'permission', 'workflow', 'other'].includes(data.kind), '变更分类无效。');
  need(baseSource.filename !== source.filename || baseSource.content !== source.content, '文件名和正文均未变化。');
  const previousPlan = planData(data.previousPlan), blocks = compare(baseSource.content, source.content), metadataOnly = baseSource.content === source.content;
  const changes = { metadataOnly, rename: baseSource.filename === source.filename ? null : { from: baseSource.filename, to: source.filename }, blocks };
  const persistence = previousPlan?.persistence ?? 'unknown';
  const impact = { unknown: true, coverage: 'conservative_all', requirementIds: previousPlan?.requirements.map(item => item.id) ?? [], taskIds: previousPlan?.tasks.map(item => item.id) ?? [],
    writePaths: unique([...(previousPlan?.writePaths ?? []), ...(previousPlan?.tasks.flatMap(item => item.writePaths) ?? [])]), allDownstream: true,
    requiresFullRegression: true, reusableValidation: false, codeReuse: 'undecided', requiresNewSpecApproval: true, requiresNewPlanApproval: true,
    persistence, requiresMigrationReview: ['field', 'workflow'].includes(data.kind) && persistence !== 'absent',
    notice: '文本比较不证明语义影响；全部旧任务与所有下游均须新版本审阅和回归，旧通过不可继承。' };
  const draft = { version: 1, projectId, baseRevision: data.baseRevision, sourceRevision: contentRevision(source), baseSource, source, reason, kind: data.kind,
    previousPlan, changes, impact, policyHash: requirementChangePolicy.hash, status: 'draft', coverage: 'conservative_all' };
  const result = { ...draft, hash: contentRevision(draft) }; need(Buffer.byteLength(JSON.stringify(result)) <= OUTPUT_BYTES, '变更草案输出超出4MiB预算。'); return freeze(result);
}
