import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const approvals = new WeakMap(), compiled = new WeakMap();
const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_migration_contract' }); };
const need = (value, message = '迁移合同、确认或当前版本无效。') => { if (!value) fail(message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HASH = /^[a-f0-9]{64}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u;
const keys = ['projectId', 'runId', 'sourceRevision', 'sourceGeneration', 'specRevision', 'planRevision', 'inputSnapshotHash', 'inputSchemaHash'];
const name = value => { need(typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value) && !/^sqlite_/iu.test(value), '仅允许普通表与列的有界标识符。'); return value; };
function object(raw, names) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype && !Object.getOwnPropertySymbols(raw).length);
  const fields = Object.getOwnPropertyDescriptors(raw);
  need(Object.keys(fields).length === names.length && names.every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], 'value')));
  return Object.fromEntries(names.map(key => [key, fields[key].value]));
}
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function array(raw, maximum) {
  need(Array.isArray(raw) && Object.getPrototypeOf(raw) === Array.prototype && raw.length <= maximum && !Object.getOwnPropertySymbols(raw).length);
  const fields = Object.getOwnPropertyDescriptors(raw); need(Object.keys(fields).length === raw.length + 1);
  return Array.from({ length: raw.length }, (_, index) => { need(fields[index]?.enumerable && Object.hasOwn(fields[index], 'value')); return fields[index].value; });
}
function scalar(value) {
  need(value === null || typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= 4096 && !value.includes('\0') || Number.isSafeInteger(value)); return value;
}
function binding(raw) {
  const value = object(raw, keys);
  need(typeof value.projectId === 'string' && typeof value.runId === 'string' && ID.test(value.projectId) && ID.test(value.runId) && Number.isSafeInteger(value.sourceGeneration) && value.sourceGeneration >= 0);
  for (const key of keys.filter(key => !['projectId', 'runId', 'sourceGeneration'].includes(key))) need(typeof value[key] === 'string' && HASH.test(value[key]));
  return freeze(value);
}

export const migrationContractPolicy = freeze({ version: 'bounded-sqlite-evolution-v1', maxOperations: 16, maxMapping: 32, implementationHash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') });

/** Pure normalization never grants execution. No SQL, paths or callbacks are accepted. */
export function normalizeMigrationPlan(raw) {
  const value = object(raw, ['version', 'kind', 'operations']); need(value.version === 1 && ['none', 'bounded_operations'].includes(value.kind));
  const used = new Set();
  const operations = array(value.operations, 16).map(rawOperation => {
    const opField = Object.getOwnPropertyDescriptor(rawOperation ?? {}, 'op'); need(opField && Object.hasOwn(opField, 'value'));
    if (opField.value === 'addColumn') {
      const op = object(rawOperation, ['op', 'table', 'column', 'type', 'nullable', 'default']); name(op.table); name(op.column);
      need(['TEXT', 'INTEGER'].includes(op.type) && typeof op.nullable === 'boolean'); scalar(op.default);
      need(op.default !== null || op.nullable); need(op.default === null || (op.type === 'INTEGER' ? Number.isSafeInteger(op.default) : typeof op.default === 'string'));
      need(!used.has(`${op.table}:${op.column}`)); used.add(`${op.table}:${op.column}`); return op;
    }
    const op = object(rawOperation, ['op', 'table', 'column', 'mapping', 'unmapped']); need(op.op === 'mapValues' && op.unmapped === 'reject'); name(op.table); name(op.column);
    need(!used.has(`${op.table}:${op.column}`)); used.add(`${op.table}:${op.column}`);
    const values = new Set(); op.mapping = array(op.mapping, 32).map(rawEntry => {
      const entry = object(rawEntry, ['from', 'to']); scalar(entry.from); scalar(entry.to); const encoded = JSON.stringify([typeof entry.from, entry.from]); need(!values.has(encoded)); values.add(encoded); return entry;
    }); need(op.mapping.length > 0); return op;
  });
  need(value.kind === 'none' ? operations.length === 0 : operations.length > 0);
  return freeze({ version: 1, kind: value.kind, operations });
}

/** Trusted controller only; HTTP approval JSON must first pass the existing role/version gates. */
export function createMigrationControl({ assertCurrent = () => true } = {}) {
  need(typeof assertCurrent === 'function'); const state = { live: true, revision: 0 };
  const current = () => { need(state.live); const result = assertCurrent(); need(result !== false && !result?.then); };
  return Object.freeze({
    approve({ plan, binding: rawBinding, feedback } = {}) {
      current(); need(typeof feedback === 'string' && !!feedback.trim() && feedback.length <= 4000);
      const normalized = normalizeMigrationPlan(plan), target = binding(rawBinding), revision = hash({ plan: normalized, binding: target, policy: migrationContractPolicy });
      state.revision++; const handle = Object.freeze({ kind: 'migration_approval', id: randomUUID() }); approvals.set(handle, { plan: normalized, binding: target, revision, state, generation: state.revision, current }); return handle;
    },
    revoke() { state.revision++; }, close() { state.live = false; state.revision++; },
  });
}

export function compileMigrationPlan({ plan, binding: rawBinding, approval } = {}) {
  const proof = approvals.get(approval); need(proof); proof.current(); need(proof.generation === proof.state.revision);
  const normalized = normalizeMigrationPlan(plan), target = binding(rawBinding);
  need(hash(normalized) === hash(proof.plan) && hash(target) === hash(proof.binding));
  const handle = Object.freeze({ kind: 'approved_migration', id: randomUUID() }); compiled.set(handle, { ...proof, policy: migrationContractPolicy }); return handle;
}

export function assertMigrationPlan(handle, expectedBinding) {
  const proof = compiled.get(handle); need(proof); proof.current(); need(proof.generation === proof.state.revision);
  need(hash(binding(expectedBinding)) === hash(proof.binding));
  return freeze({ plan: proof.plan, binding: proof.binding, revision: proof.revision, policy: proof.policy });
}
