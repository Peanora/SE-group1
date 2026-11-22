import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AGENT_ROLES, createAgentSettings } from '../lib/agent-settings.mjs';

const secret = 'fixture-only-api-secret-123456';
const allRoles = id => Object.fromEntries(AGENT_ROLES.map(role => [role.id, id]));
const provider = (values = {}) => ({ id: randomUUID(), name: '需求模型 API', baseUrl: 'https://models.example.test/v1', model: 'fixture-model', apiKey: secret, jsonMode: true, thinking: '', ...values });
async function fixture(t, environment = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-agent-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, settings: await createAgentSettings({ directory, environment }) };
}
const status = expected => error => error.status === expected;

test('网页多 API 可分配五个真实角色，密钥不进入 DTO 或配置明文，重启后保留', async t => {
  const { settings, directory } = await fixture(t);
  assert.deepEqual(settings.view().roles, allRoles('env'));
  assert.equal(settings.view().environment.configured, false);
  const first = provider(), second = provider({ name: '审查 API', model: 'review-model', apiKey: 'second-fixture-secret-987', jsonMode: false, thinking: 'disabled' });
  const roles = { ...allRoles(first.id), review: second.id };
  const view = await settings.save({ revision: 0, providers: [first, second], roles });
  assert.equal(view.revision, 1); assert.equal(view.providers[0].hasKey, true);
  assert.equal(view.providers[0].thinking, '');
  assert.equal(Object.hasOwn(view.providers[0], 'apiKey'), false);
  assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal((await readFile(path.join(directory, 'agent-settings.json'), 'utf8')).includes(secret), false);
  const restarted = await createAgentSettings({ directory, environment: {} });
  assert.deepEqual(restarted.view(), view);
  assert.deepEqual(restarted.resolve('review'), {
    baseUrl: second.baseUrl, model: second.model, apiKey: second.apiKey, jsonMode: false, thinking: 'disabled',
  });
  assert.equal(Object.isFrozen(restarted.resolve('coding')), true);
  assert.equal(Object.hasOwn(restarted.resolve('coding'), 'thinking'), true);
  assert.equal(restarted.resolve('coding').thinking, undefined);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(directory, 'agent-settings.key'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(directory, 'agent-settings.json'))).mode & 0o777, 0o600);
  }
});

test('整体版本 CAS 拒绝过期和并发覆盖，失败不改变已保存配置', async t => {
  const { settings, directory } = await fixture(t);
  const row = provider(), roles = allRoles(row.id);
  await settings.save({ revision: 0, providers: [row], roles });
  await assert.rejects(settings.save({ revision: 0, providers: [], roles: allRoles('env') }), status(409));
  assert.equal(settings.view().revision, 1);
  const another = await createAgentSettings({ directory, environment: {} });
  const writes = await Promise.allSettled([
    settings.save({ revision: 1, providers: [row], roles }),
    another.save({ revision: 1, providers: [row], roles }),
  ]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await createAgentSettings({ directory, environment: {} })).view().revision, 2);
});

test('模型单价跟随服务模型持久化，旧配置可往返，同一模型改名保留单价', async t => {
  const { settings, directory } = await fixture(t);
  const pricing = { currency: 'USD', inputPerMillion: 0, outputPerMillion: 2.5 }, row = provider({ pricing });
  let view = await settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) });
  const pinned = settings.resolve('coding');
  assert.deepEqual(pinned.pricing, pricing);
  assert.ok(Object.isFrozen(pinned.pricing));
  const restarted = await createAgentSettings({ directory, environment: {} });
  assert.deepEqual(restarted.resolve('review').pricing, pricing);
  const { pricing: savedPricing, ...legacy } = view.providers[0];
  assert.deepEqual(savedPricing, pricing);
  view = await restarted.save({ revision: view.revision, providers: [{ ...legacy, name: '更新服务显示名称' }], roles: view.roles });
  assert.deepEqual(view.providers[0].pricing, pricing);
  await assert.rejects(restarted.save({ revision: view.revision, providers: [{ ...legacy, pricing: { ...pricing, inputPerMillion: -1 } }], roles: view.roles }), status(400));
  view = await restarted.save({ revision: view.revision, providers: [{ ...legacy, model: 'new-model' }], roles: view.roles });
  assert.equal(view.providers[0].pricing, undefined);
  view = await restarted.save({ revision: view.revision, providers: [{ ...view.providers[0], pricing }], roles: view.roles });
  view = await restarted.save({ revision: view.revision, providers: [{ ...view.providers[0], pricing: null }], roles: view.roles });
  assert.equal(view.providers[0].pricing, undefined);
  assert.deepEqual(pinned.pricing, pricing);
});

test('编辑保留密钥与原运行快照，清空远程密钥和删除仍绑定 API 被拒绝', async t => {
  const { settings } = await fixture(t);
  const row = provider(); let view = await settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) });
  const pinned = settings.resolve('spec');
  view = await settings.save({ revision: view.revision, providers: [{ ...view.providers[0], model: 'updated-model', apiKey: '  ' }], roles: view.roles });
  assert.equal(settings.resolve('spec').apiKey, secret); assert.equal(settings.resolve('spec').model, 'updated-model');
  assert.equal(pinned.model, 'fixture-model');
  await assert.rejects(settings.save({ revision: 2, providers: [{ ...view.providers[0], clearKey: true }], roles: view.roles }), status(400));
  await assert.rejects(settings.save({ revision: 2, providers: [], roles: view.roles }), status(400));
  assert.equal(settings.view().revision, 2);
  view = await settings.save({ revision: 2, providers: [], roles: allRoles('env') });
  assert.equal(view.providers.length, 0); assert.equal(view.revision, 3);
});

test('本地 API 可无密钥，显式清除密钥；远程更新要补密钥', async t => {
  const { settings } = await fixture(t);
  const row = provider({ baseUrl: 'http://127.0.0.1:8888/v1' });
  let view = await settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) });
  view = await settings.save({ revision: 1, providers: [{ ...view.providers[0], clearKey: true }], roles: view.roles });
  assert.equal(view.providers[0].hasKey, false); assert.equal(settings.resolve('coding').apiKey, '');
  await assert.rejects(settings.save({ revision: 2, providers: [{ ...view.providers[0], baseUrl: 'https://remote.example.test/v1' }], roles: view.roles }), status(400));
});

test('环境配置沿用兼容控制项，凭据 URL 和无效 controls 不暴露或发放', async t => {
  const environment = { LLM_BASE_URL: 'https://env.example.test/v1/', LLM_MODEL: 'env-fixture', LLM_API_KEY: 'environment-fixture-key', LLM_JSON_MODE: '0', LLM_THINKING: 'disabled' };
  const { settings } = await fixture(t, environment);
  assert.equal(settings.view().environment.configured, true);
  assert.deepEqual(settings.resolve('spec'), { baseUrl: 'https://env.example.test/v1', model: 'env-fixture', apiKey: environment.LLM_API_KEY, jsonMode: false, thinking: 'disabled' });
  environment.LLM_BASE_URL = 'https://user:password@env.example.test/v1';
  assert.deepEqual(settings.view().environment, { configured: false, model: '', baseUrl: '' });
  assert.throws(() => settings.resolve('spec'), status(400));
  environment.LLM_BASE_URL = 'http://localhost:8888/v1'; environment.LLM_API_KEY = ''; environment.LLM_THINKING = 'bad';
  assert.equal(settings.view().environment.configured, false);
  assert.throws(() => settings.resolve('coding'), /LLM_THINKING/u);
  environment.LLM_THINKING = ''; environment.LLM_JSON_MODE = '';
  assert.equal(settings.resolve('spec').jsonMode, undefined); assert.equal(settings.resolve('spec').thinking, undefined);
});

test('只接受基础 HTTP(S) 地址、合法字段和完整角色绑定', async t => {
  const { settings } = await fixture(t);
  for (const baseUrl of ['file:///secret', 'ftp://models.test/v1', 'https://user:pass@models.test', 'https://models.test/v1?token=oops', 'https://models.test/#x', 'https://models.test/v1/chat/completions/', 'https://models.test/v1?', 'https://models.test\\v1']) {
    const row = provider({ baseUrl });
    await assert.rejects(settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) }), status(400));
  }
  const row = provider();
  for (const raw of [
    { revision: 0, providers: [{ ...row, protocol: 'custom' }], roles: allRoles(row.id) },
    { revision: 0, providers: [row], roles: { spec: row.id } },
    { revision: 0, providers: [row, row], roles: allRoles(row.id) },
    { revision: 0, providers: [row], roles: { ...allRoles(row.id), mystery: row.id } },
    { revision: 0, providers: [row], roles: allRoles(row.id), extra: true },
    { revision: 0, providers: [{ ...row, thinking: 'automatic' }], roles: allRoles(row.id) },
  ]) await assert.rejects(settings.save(raw), status(400));
  assert.throws(() => settings.resolve('mystery'), status(400));
  assert.equal(settings.view().revision, 0);
});

test('公共 JSON 防线遮蔽当前与历史密钥，拒绝元数据藏密钥，保留 JSON 数值和空值', async t => {
  const { settings } = await fixture(t, { LLM_API_KEY: 'old-env-fixture-key' });
  const row = provider(); let view = await settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) });
  view = await settings.save({ revision: 1, providers: [{ ...view.providers[0], apiKey: 'new-fixture-secret' }], roles: view.roles });
  const raw = { error: `Bearer ${secret} new-fixture-secret old-env-fixture-key`, count: 3, ok: true, value: null, nested: [0, secret] };
  const redacted = settings.redact(raw);
  assert.equal(redacted.count, 3); assert.equal(redacted.ok, true); assert.equal(redacted.value, null); assert.equal(redacted.nested[0], 0);
  assert.equal(JSON.stringify(redacted).includes(secret), false); assert.notEqual(redacted, raw); assert.equal(raw.nested[1], secret);
  for (const patch of [{ name: secret }, { model: 'new-fixture-secret' }, { baseUrl: `https://models.test/${secret}` }]) {
    await assert.rejects(settings.save({ revision: 2, providers: [{ ...view.providers[0], ...patch }], roles: view.roles }), status(400));
  }
  await settings.save({ revision: 2, providers: [], roles: allRoles('env') });
  assert.equal(settings.redact(secret), '[已隐藏密钥]');
});

test('损坏或缺失的解密资料明确失败，不静默覆盖旧配置', async t => {
  const { settings, directory } = await fixture(t);
  const row = provider(); await settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) });
  await writeFile(path.join(directory, 'agent-settings.json'), '{broken', { mode: 0o600 });
  await assert.rejects(createAgentSettings({ directory, environment: {} }), /无法读取或解密/u);
  await assert.rejects(settings.save({ revision: 1, providers: [], roles: allRoles('env') }), /无法读取或解密/u);
  assert.equal(await readFile(path.join(directory, 'agent-settings.json'), 'utf8'), '{broken');
});

test('缺失解密文件不自动生成新密钥覆盖历史，篡改密文也不能当新配置', async t => {
  const { settings, directory } = await fixture(t);
  const row = provider(); await settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) });
  const filename = path.join(directory, 'agent-settings.json');
  const original = await readFile(filename, 'utf8'), envelope = JSON.parse(original);
  envelope.ciphertext = Buffer.from('not-authenticated-ciphertext').toString('base64');
  await writeFile(filename, JSON.stringify(envelope));
  await assert.rejects(createAgentSettings({ directory, environment: {} }), /无法读取或解密/u);
  await writeFile(filename, original); await rm(path.join(directory, 'agent-settings.key'));
  await assert.rejects(createAgentSettings({ directory, environment: {} }), /解密文件缺失/u);
  assert.equal(await readFile(filename, 'utf8'), original);
});

test('对象访问器不会执行，超出输入限制与密钥冲突不发布配置', async t => {
  const { settings } = await fixture(t);
  let called = false; const row = provider();
  Object.defineProperty(row, 'name', { enumerable: true, get() { called = true; return 'not-allowed'; } });
  await assert.rejects(settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) }), status(400));
  assert.equal(called, false);
  for (const patch of [{ name: 'a'.repeat(81) }, { model: 'a'.repeat(201) }, { apiKey: 'a'.repeat(4097) }, { apiKey: secret, clearKey: true }]) {
    const next = provider(patch);
    await assert.rejects(settings.save({ revision: 0, providers: [next], roles: allRoles(next.id) }), status(400));
  }
  assert.equal(settings.view().revision, 0);
});

test('配置目录拒绝链接，并拒绝替换成链接的配置文件', async t => {
  const { settings, directory } = await fixture(t);
  const linked = `${directory}-link`; t.after(() => rm(linked, { force: true, recursive: true }));
  try { await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('当前宿主不允许创建链接。'); throw error; }
  await assert.rejects(createAgentSettings({ directory: linked, environment: {} }), /不可使用链接/u);
  const target = path.join(directory, 'other.json'); await writeFile(target, 'unchanged');
  try { await symlink(target, path.join(directory, 'agent-settings.json')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return; throw error; }
  const row = provider(); await assert.rejects(settings.save({ revision: 0, providers: [row], roles: allRoles(row.id) }), /不可使用链接/u);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});
