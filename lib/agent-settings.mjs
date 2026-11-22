import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { snapshotModelControls } from './planner.mjs';
import { normalizeModelPricing } from './planned-model-cost.mjs';

export const AGENT_ROLES = Object.freeze([
  { id: 'spec', label: '需求分析 Agent', description: '整理需求、澄清问题并生成规格。' },
  { id: 'engineering', label: '工程设计 Agent', description: '生成架构、接口和开发任务。' },
  { id: 'verification', label: '测试设计 Agent', description: '提出独立验收定义，测试执行仍由平台控制。' },
  { id: 'coding', label: '编码 Agent', description: '在受控工作区生成与修复候选代码。' },
  { id: 'review', label: '代码审查 Agent', description: '审查固定候选版本并报告阻塞问题。' },
].map(Object.freeze));

const FORMAT = 'taskflow-agent-settings-v1', MAX_BYTES = 256 * 1024;
const roleIds = AGENT_ROLES.map(role => role.id), queues = new Map();
const fail = (status, message, code = 'invalid_agent_settings') => { throw Object.assign(new Error(message), { status, code }); };
const need = (value, status, message, code) => { if (!value) fail(status, message, code); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const defaults = () => Object.fromEntries(roleIds.map(id => [id, 'env']));

function fields(value, allowed, required = []) {
  need(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Object.getOwnPropertySymbols(value).length, 400, 'Agent 配置必须是普通对象。');
  const entries = Object.getOwnPropertyDescriptors(value);
  need(Object.keys(entries).every(key => allowed.includes(key) && entries[key].enumerable && Object.hasOwn(entries[key], 'value'))
    && required.every(key => Object.hasOwn(entries, key)), 400, 'Agent 配置字段无效。');
  return Object.fromEntries(Object.entries(entries).map(([key, descriptor]) => [key, descriptor.value]));
}
function text(value, max, message, empty = false) {
  need(typeof value === 'string' && value.isWellFormed() && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value), 400, message);
  const result = value.trim(); need(empty || result, 400, message); return result;
}
function endpoint(value) {
  const raw = text(value, 2000, 'API 基础地址无效。'); let parsed;
  try { parsed = new URL(raw); } catch { fail(400, 'API 基础地址无效。'); }
  need(['http:', 'https:'].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password
    && !parsed.search && !parsed.hash && !raw.includes('?') && !raw.includes('#') && !raw.includes('\\')
    && !/\/chat\/completions\/*$/iu.test(parsed.pathname), 400, '请填写不含凭据、查询参数或 chat/completions 路径的 HTTP(S) 基础地址。');
  return parsed.href.replace(/\/+$/u, '');
}
const local = baseUrl => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname);

async function privateDirectory(directory, create = false) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current), actual = await realpath(current);
    need(info.isDirectory() && !info.isSymbolicLink() && samePath(actual, current), 500, 'Agent 配置目录不可使用链接。');
  }
}
async function privateFile(filename, optional = false) {
  try {
    const info = await lstat(filename), actual = await realpath(filename);
    need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && samePath(actual, filename), 500, 'Agent 配置文件不可使用链接。');
    return info;
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

/** Local server configuration. Secrets never appear in view(), persisted project runs or error text. */
export async function createAgentSettings({ directory, environment = process.env } = {}) {
  need(typeof directory === 'string' && path.isAbsolute(directory) && path.resolve(directory) !== path.parse(directory).root, 500, 'Agent 配置目录无效。');
  const absolute = path.resolve(directory), filename = path.join(absolute, 'agent-settings.json'), keyfile = path.join(absolute, 'agent-settings.key');
  await privateDirectory(absolute, true);
  const secrets = new Set(); let orderedSecrets = [], replacement = '[已隐藏密钥]';
  const remember = key => {
    if (typeof key === 'string' && key && !secrets.has(key)) {
      secrets.add(key); orderedSecrets = [...secrets].sort((a, b) => b.length - a.length);
      replacement = orderedSecrets.some(value => '[已隐藏密钥]'.includes(value)) ? '' : '[已隐藏密钥]';
    }
  };
  const scrub = value => {
    if (typeof value === 'string') {
      let output = value;
      for (const key of orderedSecrets) output = output.split(key).join(replacement);
      return output;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key), scrub(item)]));
    return value;
  };
  const rememberEnvironment = () => remember(typeof environment.LLM_API_KEY === 'string' ? environment.LLM_API_KEY.trim() : '');
  rememberEnvironment();

  let keyInfo = await privateFile(keyfile, true);
  if (!keyInfo) {
    need(!await privateFile(filename, true), 500, 'Agent 配置解密文件缺失，请恢复原配置与密钥备份。');
    try {
      const handle = await open(keyfile, 'wx', 0o600);
      try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    keyInfo = await privateFile(keyfile);
  }
  need(keyInfo.size === 32, 500, 'Agent 配置解密文件无效。');
  const keyHandle = await open(keyfile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let encryptionKey;
  try { await keyHandle.chmod(0o600); encryptionKey = await keyHandle.readFile(); } finally { await keyHandle.close(); }
  need(encryptionKey.length === 32, 500, 'Agent 配置解密文件无效。');

  const metadata = value => need(![...secrets].some(key => value.includes(key)), 400, '名称、模型和地址不得包含 API 密钥。');
  function providersOf(rows, previous = [], stored = false) {
    need(Array.isArray(rows) && rows.length <= 30, 400, '最多配置30个 API。');
    const ids = new Set(), names = new Set();
    const allowed = ['id', 'name', 'baseUrl', 'model', 'jsonMode', 'thinking', 'apiKey', 'pricing', ...(stored ? [] : ['clearKey', 'hasKey'])];
    const parsed = rows.map(raw => {
      const row = fields(raw, allowed, ['id', 'name', 'baseUrl', 'model']);
      need(typeof row.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(row.id) && row.id !== 'env' && !ids.has(row.id), 400, 'API 标识重复或无效。'); ids.add(row.id);
      const name = text(row.name, 80, 'API 名称须为1至80个字符。'), model = text(row.model, 200, '模型名称须为1至200个字符。'), baseUrl = endpoint(row.baseUrl);
      need(!names.has(name), 400, 'API 名称不能重复。'); names.add(name);
      need(row.hasKey === undefined || typeof row.hasKey === 'boolean', 400, '密钥状态无效。');
      need(row.clearKey === undefined || typeof row.clearKey === 'boolean', 400, '清除密钥选项无效。');
      const prior = previous.find(old => old.id === row.id);
      let apiKey = prior?.apiKey || '';
      if (row.apiKey !== undefined) {
        const supplied = text(row.apiKey, 4096, 'API 密钥格式无效。', true);
        need(!row.clearKey || !supplied, 400, '不能同时填写和清除 API 密钥。');
        if (supplied || stored) apiKey = supplied;
      }
      if (row.clearKey) apiKey = '';
      need(apiKey || local(baseUrl), 400, '远程 API 必须配置密钥。');
      const jsonMode = row.jsonMode === undefined ? true : row.jsonMode, thinking = row.thinking === undefined ? '' : row.thinking;
      need(typeof jsonMode === 'boolean' && ['', 'enabled', 'disabled'].includes(thinking), 400, 'API JSON 或思考模式选项无效。');
      let pricing;
      try { pricing = normalizeModelPricing(row.pricing === undefined && prior?.baseUrl === baseUrl && prior.model === model ? prior.pricing : row.pricing); }
      catch (error) { fail(400, error.message); }
      remember(apiKey);
      return { id: row.id, name, baseUrl, model, apiKey, jsonMode, thinking, ...(pricing ? { pricing } : {}) };
    });
    for (const row of parsed) for (const value of [row.id, row.name, row.baseUrl, row.model, row.pricing?.currency].filter(Boolean)) metadata(value);
    return parsed;
  }
  function rolesOf(raw, providers) {
    const roles = fields(raw, roleIds, roleIds), ids = new Set(providers.map(row => row.id));
    need(Object.values(roles).every(id => typeof id === 'string' && (id === 'env' || ids.has(id))), 400, '角色绑定的 API 不存在；请先重新绑定再删除。');
    return roles;
  }
  async function load() {
    await privateDirectory(absolute);
    const info = await privateFile(filename, true);
    if (!info) return { revision: 0, providers: [], roles: defaults() };
    need(info.size <= MAX_BYTES, 500, 'Agent 配置文件过大。');
    try {
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); let raw;
      try { await handle.chmod(0o600); raw = await handle.readFile('utf8'); } finally { await handle.close(); }
      const envelope = fields(JSON.parse(raw), ['format', 'iv', 'tag', 'ciphertext'], ['format', 'iv', 'tag', 'ciphertext']);
      need(envelope.format === FORMAT && [envelope.iv, envelope.tag, envelope.ciphertext].every(value => typeof value === 'string'), 500, 'Agent 配置文件无效。');
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(FORMAT)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const rawState = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
      const state = fields(rawState, ['revision', 'providers', 'roles'], ['revision', 'providers', 'roles']);
      need(Number.isSafeInteger(state.revision) && state.revision > 0, 500, 'Agent 配置版本无效。');
      const providers = providersOf(state.providers, [], true), roles = rolesOf(state.roles, providers);
      return { revision: state.revision, providers, roles };
    } catch { fail(500, 'Agent 配置文件无法读取或解密，请恢复原配置与密钥备份。'); }
  }
  let state = await load();

  function environmentConfig() {
    rememberEnvironment();
    const apiKey = typeof environment.LLM_API_KEY === 'string' ? environment.LLM_API_KEY.trim() : '';
    const baseUrl = endpoint(environment.LLM_BASE_URL || ''), model = text(environment.LLM_MODEL || '', 200, '环境模型尚未配置。');
    metadata(baseUrl); metadata(model);
    need(apiKey || local(baseUrl), 400, '环境模型尚未配置所需密钥。');
    return Object.freeze({ baseUrl, model, apiKey, jsonMode: undefined, thinking: undefined, ...snapshotModelControls({}, environment) });
  }
  function view() {
    let env;
    try { const resolved = environmentConfig(); env = { configured: true, model: resolved.model, baseUrl: resolved.baseUrl }; }
    catch { env = { configured: false, model: '', baseUrl: '' }; }
    return scrub({ revision: state.revision,
      providers: state.providers.map(({ apiKey, ...row }) => ({ ...row, hasKey: Boolean(apiKey) })),
      roles: { ...state.roles }, roleDefinitions: AGENT_ROLES.map(row => ({ ...row })), environment: env });
  }
  function resolve(role) {
    need(roleIds.includes(role), 400, 'Agent 角色不存在。');
    const providerId = state.roles[role];
    if (providerId === 'env') return environmentConfig();
    const row = state.providers.find(provider => provider.id === providerId);
    need(row, 409, '角色绑定的 API 已失效，请重新配置。');
    return Object.freeze({ baseUrl: row.baseUrl, model: row.model, apiKey: row.apiKey, jsonMode: row.jsonMode, thinking: row.thinking || undefined,
      ...(row.pricing ? { pricing: row.pricing } : {}) });
  }
  async function persist(next) {
    await privateDirectory(absolute); await privateFile(filename, true); await privateFile(keyfile);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); cipher.setAAD(Buffer.from(FORMAT));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ format: FORMAT, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    need(Buffer.byteLength(envelope) <= MAX_BYTES, 400, 'Agent 配置过大，请减少 API 或密钥长度。');
    const temporary = path.join(absolute, `.agent-settings-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(envelope); await handle.sync(); } finally { await handle.close(); }
      await privateDirectory(absolute); await privateFile(filename, true); await rename(temporary, filename); created = false;
    } finally { if (created) await unlink(temporary).catch(() => {}); }
  }
  async function save(raw) {
    // This local controller serializes writes, including callers with another handle in this process.
    const previous = queues.get(absolute) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const body = fields(raw, ['revision', 'providers', 'roles'], ['revision', 'providers', 'roles']);
      need(Number.isSafeInteger(body.revision) && body.revision >= 0, 400, 'Agent 配置版本无效。');
      state = await load();
      need(body.revision === state.revision, 409, 'Agent 配置已被修改，请刷新后重新保存。', 'agent_settings_conflict');
      rememberEnvironment();
      const providers = providersOf(body.providers, state.providers), roles = rolesOf(body.roles, providers);
      const next = { revision: state.revision + 1, providers, roles };
      await persist(next); state = next; return view();
    });
    queues.set(absolute, operation);
    try { return await operation; } finally { if (queues.get(absolute) === operation) queues.delete(absolute); }
  }
  return Object.freeze({ view, save, resolve, redact(value) { rememberEnvironment(); return scrub(value); } });
}
