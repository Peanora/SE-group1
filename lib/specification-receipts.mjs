import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeWithModel } from './planner.mjs';
import { guardModelContent } from './model-content-guard.mjs';

const fail = () => { throw Object.assign(new Error('规格回执格式或私有存储无效。'), { code: 'receipt_failed' }); };
const finishes = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'unknown']);
function fields(raw, names) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.getOwnPropertySymbols(raw).length) fail();
  const own = Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(own).length !== names.length || names.some(name => !own[name]?.enumerable || !Object.hasOwn(own[name], 'value'))) fail();
  return Object.fromEntries(names.map(name => [name, own[name].value]));
}
export function specificationReceipt(raw) {
  const value = fields(raw, ['model', 'finishReason', 'usage', 'content']), usage = fields(value.usage, ['inputTokens', 'outputTokens']);
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || !value.model.isWellFormed() || typeof value.content !== 'string' || !value.content.isWellFormed() || Buffer.byteLength(value.content) > 512 * 1024
    || !finishes.has(value.finishReason) || Object.values(usage).some(item => item !== null && (!Number.isSafeInteger(item) || item < 0))) fail();
  const key = process.env.LLM_API_KEY || '';
  if (guardModelContent(value.model, key).credentialResponse) throw Object.assign(new Error('规格模型元数据含配置凭据。'), { code: 'credential_response' });
  const guarded = guardModelContent(value.content, key);
  return { receipt: { model: value.model, finishReason: value.finishReason, usage, content: guarded.content }, credentialResponse: guarded.credentialResponse };
}

export function specificationReceiptInfo(raw, id) {
  const info = fields(raw, ['id', 'sha256', 'bytes']);
  if (info.id !== id || typeof info.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(info.sha256) || !Number.isSafeInteger(info.bytes) || info.bytes < 1 || info.bytes > 2 * 1024 * 1024) fail();
  return info;
}

/** Descriptor-based bounded data copy: providers cannot run getters during publication. */
export function specificationData(raw) {
  let bytes = 0, nodes = 0; const ancestors = new Set();
  function copy(value, depth) {
    if (++nodes > 20000 || depth > 20) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.isWellFormed()) { bytes += Buffer.byteLength(value); if (bytes > 1024 * 1024) fail(); return value; }
    if (!value || typeof value !== 'object' || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) fail();
    const array = Array.isArray(value), own = Object.getOwnPropertyDescriptors(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const length = array ? own.length?.value : 0, keys = Object.keys(own).filter(key => !(array && key === 'length'));
    if (array && (!Number.isSafeInteger(length) || length < 0 || length > 20000 || keys.length !== length)) fail();
    ancestors.add(value); const result = array ? [] : {};
    for (const key of keys) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !own[key].enumerable || !Object.hasOwn(own[key], 'value') || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) fail();
      bytes += Buffer.byteLength(key); if (bytes > 1024 * 1024) fail();
      Object.defineProperty(result, key, { value: copy(own[key].value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(value); return result;
  }
  return copy(raw, 0);
}

/** Reuse the exact planner normalization with an in-memory response, never a network call. */
export function specificationFromReceipt(receipt, source, projectName, { signal, timeoutMs }) {
  if (receipt.finishReason !== 'stop') throw Object.assign(new Error('规格模型未正常结束。'), { code: 'abnormal_finish' });
  return analyzeWithModel(source, projectName, { signal, timeoutMs, config: { baseUrl: 'http://localhost', model: receipt.model, apiKey: '' },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: receipt.finishReason, message: { content: receipt.content } }], usage: { prompt_tokens: receipt.usage.inputTokens, completion_tokens: receipt.usage.outputTokens } })) });
}

export async function writeSpecificationReceipt(directory, projectId, runId, id, receipt, signal) {
  const check = () => { if (signal.aborted) fail(); };
  const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (![projectId, runId, id].every(value => typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value)) || !path.isAbsolute(directory)) fail();
  const absolute = path.resolve(directory); let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); check(); const stat = await lstat(cursor); check();
    if (!stat.isDirectory() || stat.isSymbolicLink() || !equal(await realpath(cursor), cursor)) fail();
  }
  for (const part of ['.private', 'specification-receipts', projectId, runId]) {
    cursor = path.join(cursor, part); check(); await mkdir(cursor, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(cursor); check(); if (!stat.isDirectory() || stat.isSymbolicLink() || !equal(await realpath(cursor), cursor)) fail();
  }
  const content = JSON.stringify(receipt), filename = path.join(cursor, `${id}.json`); if (Buffer.byteLength(content) > 2 * 1024 * 1024) fail(); check();
  await writeFile(filename, content, { flag: 'wx', mode: 0o600, signal }); check();
  const stat = await lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !equal(await realpath(filename), filename)) fail(); check();
  return { id, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) };
}
