import { createHash } from 'node:crypto';
import path from 'node:path';
import { openPlannedReadonlyLedger } from './planned-readonly-ledger.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const scopeKeys = ['evolutionId', 'evolutionRevision', 'intentId', 'authority', 'approvalHash'];
const frozenKeys = ['input', 'planningKey', 'revisionNumber', 'approval', 'migration', 'origin', 'sourceProvenance', 'retainedPaths', 'snapshot', 'targetBinding'];
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const need = ok => { if (!ok) throw Object.assign(new Error('持久演进授权、审批或当前执行归属无法核对。'), { code: 'worker_evolution_binding_changed', status: 409 }); };

export function inspectWorkerEvolution(raw) {
  need(raw && Object.getPrototypeOf(raw) === Object.prototype && Reflect.ownKeys(raw).length === scopeKeys.length);
  const fields = Object.getOwnPropertyDescriptors(raw);
  need(scopeKeys.every(key => fields[key]?.enumerable && typeof fields[key].value === 'string'));
  const value = Object.fromEntries(scopeKeys.map(key => [key, fields[key].value]));
  need([value.evolutionId, value.intentId, value.authority].every(item => ID.test(item))
    && [value.evolutionRevision, value.approvalHash].every(item => HASH.test(item)));
  return value;
}

export function describeWorkerEvolution(row, record) {
  need(record.approval?.revision === row.revision && frozenKeys.every(key => Object.hasOwn(record, key)));
  return inspectWorkerEvolution({ evolutionId: row.id, evolutionRevision: row.revision, intentId: record.startIntent?.id,
    authority: record.startIntent?.authority, approvalHash: hash(Object.fromEntries(frozenKeys.map(key => [key, record[key]]))) });
}

export function openWorkerEvolutionBinding(root, authorization) {
  const scope = inspectWorkerEvolution(authorization.evolution);
  const evolution = openPlannedReadonlyLedger(path.join(root, 'evolutions', 'evolutions.sqlite'));
  let execution;
  try { execution = openPlannedReadonlyLedger(path.join(root, 'planned.sqlite')); }
  catch (error) { evolution.close(); throw error; }
  function read({ historical = false } = {}) {
    const { executionId, binding, proposalId, revision } = authorization;
    evolution.assertCurrent();
    execution.assertCurrent();
    const row = evolution.db.prepare('SELECT * FROM evolutions WHERE id=?').get(scope.evolutionId);
    const link = execution.db.prepare('SELECT * FROM evolution_starts WHERE intent_id=?').get(scope.intentId);
    const planned = execution.db.prepare('SELECT * FROM executions WHERE id=?').get(executionId);
    need(row?.project_id === binding.projectId && row.run_id === binding.runId && row.revision === scope.evolutionRevision
      && (historical || ['starting', 'running', 'reconciliation_required'].includes(row.status)));
    need(link?.execution_id === executionId && link.evolution_id === row.id && link.evolution_revision === row.revision
      && execution.db.prepare('SELECT nonce FROM evolution_start_authority WHERE id=1').get()?.nonce === scope.authority
      && planned?.project_id === row.project_id && planned.run_id === row.run_id && planned.proposal_id === proposalId
      && planned.definition_revision === revision && (historical || planned.active === 1));
    const record = JSON.parse(row.record), pinned = JSON.parse(planned.binding);
    need(hash(describeWorkerEvolution(row, record)) === hash(scope) && (record.executionId == null || record.executionId === executionId)
      && record.input.proposalId === proposalId && record.input.definitionRevision === revision
      && ['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision'].every(key => record.targetBinding[key] === binding[key])
      && Object.entries({ ...binding, contextHash: authorization.contextHash, engineeringHash: authorization.engineeringHash }).every(([key, value]) => pinned[key] === value));
    return record;
  }
  return { read, close() { evolution.close(); execution.close(); } };
}
