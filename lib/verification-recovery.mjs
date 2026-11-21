import { createHash } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { HttpError } from './documents.mjs';
import { guardModelContent } from './model-content-guard.mjs';
import { inspectVerificationProposal, HTTP_LIMITS } from './verification-contract.mjs';
import { inspectVerificationPlanning } from './verification-planning-service.mjs';
import { repeatedCounterSteps } from '../public/verification-draft.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const editableFailure = row => row.origin === 'model' && row.status === 'failed' && row.active === 0 && row.finish_reason === 'stop'
  && row.receipt_state === 'saved' && ['invalid_model_response', 'invalid_proposal'].includes(row.error);
const samePath = (left, right) => path.relative(left, right) === '';

const dependencyError = '变量必须来自已依赖的前序捕获。';
const coverageError = '清单没有结构性覆盖全部需求。';
const requests = step => step.type === 'request' ? [step.request] : step.type === 'concurrent' ? step.requests : [];

function referencedValues(value) {
  if (!value || typeof value !== 'object') return [];
  if (Object.hasOwn(value, '$var')) return [value.$var];
  return Object.values(value).flatMap(referencedValues);
}

function completeDependencies(draft) {
  const capturingSteps = new Map(), ancestors = new Map(), additions = [];
  for (const step of draft.steps) {
    const inherited = new Set(step.dependsOn.flatMap(id => [id, ...ancestors.get(id)]));
    for (const request of requests(step)) {
      const pathVariables = [...request.path.matchAll(/\$\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu)].map(match => match[1]);
      const values = request.assertions.filter(item => item.op === 'jsonEquals').flatMap(item => referencedValues(item.value));
      for (const variable of [...pathVariables, ...referencedValues(request.body), ...values]) {
        const source = capturingSteps.get(variable);
        if (!source) return null;
        if (inherited.has(source)) continue;
        step.dependsOn.push(source);
        inherited.add(source);
        for (const id of ancestors.get(source)) inherited.add(id);
        additions.push({ stepId: step.id, dependencyId: source });
      }
    }
    for (const request of requests(step)) for (const capture of request.captures ?? []) capturingSteps.set(capture.name, step.id);
    ancestors.set(step.id, inherited);
  }
  return additions;
}

function addPublicPageChecks(draft, context) {
  const covered = new Set(draft.steps.flatMap(step => step.requirementIds));
  const missing = context.requirements.map(item => item.id).filter(id => !covered.has(id));
  const contract = context.engineeringContract;
  if (!missing.length || !contract?.views || !contract.routes || !Array.isArray(draft.browser?.steps)) return [];
  const page = contract.views.find(view => view.path === '/');
  if (!page || missing.some(id => !page.requirementIds.includes(id) || contract.routes.some(route => route.requirementIds.includes(id)))) return [];

  // Require an actual assertion on the entry page of a fresh browser session.
  // This adds HTTP reachability evidence. Existing browser behavior stays in the checklist.
  const locations = new Map(), entryAssertions = new Set();
  for (const step of draft.browser.steps) {
    if (!step || !Array.isArray(step.requirementIds)) return [];
    if (step.op === 'goto') locations.set(step.session, !locations.has(step.session) && step.path === page.path);
    if (locations.get(step.session) && ['visible', 'text'].includes(step.op) && step.value !== false
      && page.selectors.some(selector => selector.testId === step.testId)) {
      for (const id of step.requirementIds) entryAssertions.add(id);
    }
  }
  if (missing.some(id => !entryAssertions.has(id))) return [];

  const ids = new Set(draft.steps.flatMap(step => [step.id, ...requests(step).flatMap(request => [request.id, ...request.assertions.map(item => item.id)])]));
  let number = 1, prefix = `entry-page-check-${number}`;
  while ([prefix, `${prefix}-get`, `${prefix}-ok`].some(id => ids.has(id))) prefix = `entry-page-check-${++number}`;
  draft.steps.push({ id: prefix, type: 'request', dependsOn: [], requirementIds: missing,
    request: { id: `${prefix}-get`, method: 'GET', path: page.path, assertions: [{ id: `${prefix}-ok`, op: 'status', value: 200 }] } });
  return missing;
}

function splitRepeatedListCounters(draft, context) {
  const steps = draft.browser.steps;
  const views = context.engineeringContract?.views ?? [];
  const used = new Set(views.flatMap(view => view.selectors.map(selector => selector.testId)));
  const stepIds = new Set(steps.map(step => step.id));
  for (const step of steps) for (const key of ['testId', 'inputTestId', 'submitTestId', 'listTestId', 'countTestId']) used.add(step[key]);
  const changed = [], normalActions = [];
  for (const step of repeatedCounterSteps(draft)) {
    const view = views.find(item => item.path === step.path);
    if (!view?.selectors.some(selector => selector.testId === step.countTestId && selector.role === 'listitem')) continue;
    const listItem = step.countTestId;
    const position = steps.indexOf(step);
    const next = steps.slice(position + 1).find(check => check.session === step.session);
    const previous = steps.slice(0, position).findLast(check => check.session === step.session);
    let counter = 'taskflow-visible-total', index = 1;
    while (used.has(counter)) counter = `taskflow-visible-total-${++index}`;
    step.countTestId = counter;
    used.add(counter);
    changed.push(step.id);
    if (step.expectedCount === 1 && previous?.op === 'count' && previous.testId === listItem && previous.value === 0 && next?.testId === listItem
      && (next.op === 'visible' && next.value === true || next.op === 'count' && next.value === 1)) {
      let number = 1;
      while (stepIds.has(`replay-entry-${number}-fill`) || stepIds.has(`replay-entry-${number}-click`)) number++;
      const added = [{ id: `replay-entry-${number}-fill`, op: 'fill', testId: step.inputTestId, value: step.value },
        { id: `replay-entry-${number}-click`, op: 'click', testId: step.submitTestId }];
      for (const action of added) stepIds.add(action.id);
      steps.splice(position + 1, 0, ...added.map(action => ({ ...action, session: step.session, requirementIds: [...step.requirementIds] })));
      normalActions.push(step.id);
    }
  }
  return { changed, normalActions };
}

/** Repair ordering and optional grouping. Acceptance checks and their expectations stay intact. */
export function suggestVerificationDraft(proposal, context) {
  const input = { requirements: context.requirements.map(item => item.id), binding: context.binding, tasks: context.task.tasks };
  const inspect = draft => {
    try { return { valid: inspectVerificationProposal({ ...input, proposal: draft }) }; }
    catch (error) { return { error }; }
  };
  let checked = inspect(proposal);
  if (checked.error && checked.error.code !== 'invalid_contract') return null;
  const draft = structuredClone(proposal);
  let additions = [], entryPageRequirements = [];
  if (checked.error?.message === dependencyError) {
    additions = completeDependencies(draft);
    if (!additions?.length) return null;
    checked = inspect(draft);
  }
  if (checked.error?.message === coverageError) {
    entryPageRequirements = addPublicPageChecks(draft, context);
    if (entryPageRequirements.length) checked = inspect(draft);
  }
  const wholeProject = Boolean(checked.error && Object.hasOwn(draft, 'taskScopes'));
  if (wholeProject) {
    delete draft.taskScopes;
    checked = inspect(draft);
  }
  if (!checked.valid?.browser) return null;
  const counters = splitRepeatedListCounters(draft, context);
  if (counters.changed.length) checked = inspect(draft);
  if (!checked.valid?.browser || !additions.length && !wholeProject && !entryPageRequirements.length && !counters.changed.length) return null;
  const summary = [additions.length ? `已补齐 ${additions.length} 条测试步骤依赖。` : '',
    entryPageRequirements.length ? '已补上入口页面能打开的检查，原页面操作检查继续验证具体功能。' : '',
    counters.changed.length ? '已分开列表条目和总数显示的检查目标，保留创建操作和预期总数。' : '',
    counters.normalActions.length ? '已在后续普通检查的浏览器中补上同样的创建操作。' : '',
    wholeProject ? '原逐任务分组未通过校验，草案改为整项目验收。' : '',
    '接口、浏览器检查及预期结果全部保留。'].join('');
  return { draft, summary, additions, wholeProject, manifestHash: checked.valid.manifestHash };
}

function diagnose(proposal, { context }) {
  const requirements = context.requirements.map(item => item.id);
  const coverage = new Set(Array.isArray(proposal.steps) ? proposal.steps.flatMap(item => Array.isArray(item?.requirementIds) ? item.requirementIds : []) : []);
  const missing = context.requirements.filter(item => !coverage.has(item.id)).map(item => ({ id: item.id, title: item.text.split('\n')[0].slice(0, 200).toWellFormed() }));
  const httpSteps = Array.isArray(proposal.steps) ? proposal.steps.length : 0;
  try {
    const result = inspectVerificationProposal({ proposal, requirements, binding: context.binding, tasks: context.task.tasks });
    return { message: result.browser ? '' : '这份草案需要补充浏览器步骤，才能用于开始开发。', missing, httpSteps };
  } catch (error) {
    const message = error.code === 'invalid_contract' ? error.message : '草案结构不符合验收规则。';
    return { message, missing, httpSteps, maxHttpSteps: HTTP_LIMITS.steps };
  }
}

async function trustedFile(filename) {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || !samePath(await realpath(filename), filename)) throw new Error('unverified file');
  return entry;
}

export function createVerificationRecovery({ root, getPlanning }) {
  async function read({ projectId, runId, proposalId }, { editable = false } = {}) {
    if (!ID.test(proposalId) || !ID.test(projectId) || !ID.test(runId)) throw new HttpError(400, '验收清单编号无效。');
    const database = path.join(root, 'verification.sqlite');
    let row;
    try {
      await trustedFile(database);
      const db = new DatabaseSync(database, { readOnly: true });
      try { row = db.prepare('SELECT * FROM proposals WHERE project_id=? AND run_id=? AND id=?').get(projectId, runId, proposalId); }
      finally { db.close(); }
    } catch { throw new HttpError(409, '当前服务无法读取验收历史。'); }
    if (!row) throw new HttpError(404, '未找到这次验收清单。');
    const savedDraft = row.status === 'draft' && !row.active && row.proposal ? JSON.parse(row.proposal) : null;
    if (!editableFailure(row) && !repeatedCounterSteps(savedDraft).length) throw new HttpError(409, '这次记录没有需要自动修订的清单。');
    const snapshot = JSON.parse(row.snapshot);
    let current;
    try { current = inspectVerificationPlanning(await getPlanning(projectId, runId), projectId, runId); } catch { /* Historical diagnostics are still readable. */ }
    const canEditVersion = current?.key === row.context_key;
    if (editable && !canEditVersion) throw new HttpError(409, '这次草案属于旧计划。请切回当前已确认计划。');
    if (savedDraft) {
      const suggestion = suggestVerificationDraft(savedDraft, snapshot.context);
      return { proposalId, diagnostic: { message: suggestion?.summary ?? '这份清单可以正常确认。', missing: [], canLoad: false,
        ...(canEditVersion && suggestion ? { suggestedRepair: suggestion.summary } : {}) }, ...(editable ? { draft: savedDraft } : {}) };
    }
    let receipt;
    try {
      const filename = path.join(root, 'receipts', `${proposalId}.json`), stat = await trustedFile(filename);
      if (stat.size !== row.receipt_bytes || stat.size > 2 * 1024 * 1024) throw new Error('receipt size');
      const bytes = await readFile(filename);
      if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== row.receipt_hash) throw new Error('receipt integrity');
      receipt = JSON.parse(bytes.toString('utf8'));
    } catch { throw new HttpError(409, '保存的模型响应缺失或完整性核对失败。'); }
    if (receipt?.finishReason !== 'stop' || typeof receipt.content !== 'string' || Buffer.byteLength(receipt.content) > HTTP_LIMITS.proposalBytes
      || guardModelContent(receipt.content, process.env.LLM_API_KEY || '', HTTP_LIMITS.proposalBytes).credentialResponse) {
      throw new HttpError(409, '这次模型响应无法安全用于修订。');
    }
    let candidate;
    try {
      candidate = JSON.parse(receipt.content.trim().replace(/^```(?:json)?\s*\n/iu, '').replace(/\n```$/u, ''), (key, value) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('unsupported field');
        return value;
      });
    } catch { /* Show a format error without returning raw model output. */ }
    if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') {
      if (editable) throw new HttpError(409, '模型响应中没有可载入的清单对象。可以导入已有验收清单。');
      return { proposalId, diagnostic: { message: '模型响应中没有可编辑的清单对象。可以导入已有验收清单。', missing: [], canLoad: false } };
    }
    const diagnostic = diagnose(candidate, snapshot);
    const suggestion = suggestVerificationDraft(candidate, snapshot.context);
    diagnostic.message ||= '现有规则可以读取这份草案。载入后仍需保存并审阅。';
    return { proposalId, diagnostic: { ...diagnostic, canLoad: canEditVersion,
      ...(canEditVersion && suggestion ? { suggestedRepair: suggestion.summary } : {}) }, ...(editable ? { draft: candidate } : {}) };
  }

  async function save(identity, body, { checkAccess, importDefinition, list }) {
    const { draft } = await read(identity, { editable: true });
    const current = inspectVerificationPlanning(await getPlanning(identity.projectId, identity.runId), identity.projectId, identity.runId);
    let { proposal, feedback } = body;
    if (!Object.hasOwn(body, 'proposal')) {
      const suggestion = suggestVerificationDraft(draft, current.context);
      if (!suggestion) throw new HttpError(409, '这份失败草案需要补充或修改检查内容后保存。');
      proposal = suggestion.draft;
      feedback = `修复模型提案 ${identity.proposalId}。${suggestion.summary}`;
      checkAccess();
      const state = await list({ projectId: identity.projectId, runId: identity.runId });
      if (state.capabilities.contractRevision !== body.contractRevision) throw new HttpError(409, '验收规则已变化，请刷新后再修复。');
      const existing = state.proposals.find(item => item.current && item.origin === 'manual' && item.manifestHash === suggestion.manifestHash && ['draft', 'approved'].includes(item.status));
      if (existing?.status === 'draft') { checkAccess(); return { proposal: existing }; }
      if (existing) throw new HttpError(409, '修复后的清单已经认可，请查看当前验收清单。');
    }
    const diagnostic = diagnose(proposal ?? {}, current);
    if (diagnostic.message) {
      const missing = diagnostic.missing.map(item => item.id).join('、');
      throw new HttpError(400, `${diagnostic.message}${missing ? ` 缺少接口检查：${missing}。` : ''}`);
    }
    checkAccess();
    return importDefinition({ projectId: identity.projectId, runId: identity.runId, contractRevision: body.contractRevision, proposal, feedback });
  }

  return { read, save };
}
