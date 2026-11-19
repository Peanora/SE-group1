import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

const evidence = path.resolve(import.meta.dirname, '../output/full-goal-20261117/team-browser-independent');
const password = 'Synthetic-Browser-Password-7641!';
const wrongPassword = 'Synthetic-Wrong-Password-9023!';
let browser;
before(async () => { await mkdir(evidence, { recursive: true }); browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(t, enabled = true) {
  const directory = await mkdtemp(path.join(evidence, 'case-'));
  const app = await createApp({ dataDir: directory, teamEnabled: enabled, stepDelayMs: 0, executionService: null, verificationPlanningService: null, plannedExecutionService: null,
    planner: { ...planner, getModelConfig: () => ({ configured: false, model: 'no-remote-team-browser' }), analyzeWithModel: () => { throw new Error('paid model is outside browser acceptance'); } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${app.server.address().port}`, contexts = [], observations = [];
  t.after(async () => {
    for (const context of contexts) await context.close(); await app.close();
    await writeFile(path.join(directory, 'browser-observations.json'), JSON.stringify(observations, null, 2));
    for (const observation of observations) {
      assert.deepEqual(observation.pageErrors, []); assert.deepEqual(observation.externalRequests, []);
      assert.deepEqual(observation.consoleErrors.filter(entry => !observation.expectedFailures.some(expected => expected.url === entry.url && entry.text.includes(`status of ${expected.status}`))), []);
    }
  });
  const page = async (width = 1440) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 } }); contexts.push(context); const page = await context.newPage(); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
    const observation = { width, pageErrors: [], consoleErrors: [], externalRequests: [], expectedFailures: [] }; observations.push(observation);
    page.on('pageerror', error => observation.pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') observation.consoleErrors.push({ text: message.text(), url: message.location().url }); });
    page.on('request', request => { if (/^https?:/u.test(request.url()) && new URL(request.url()).origin !== origin) observation.externalRequests.push(request.url()); });
    page.expectedFailure = (target, status) => observation.expectedFailures.push({ url: origin + target, status });
    return page;
  };
  return { app, origin, directory, page };
}
async function workbench(page, f) { await page.waitForURL(f.origin + '/'); await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent.includes('服务已连接')); }
async function openLogin(page, f) { await page.goto(f.origin + '/'); await page.waitForURL(f.origin + '/team.html'); await page.locator('#team-login').waitFor({ state: 'visible' }); }
async function login(page, f, name, value = password) { await page.locator('#login-name').fill(name); await page.locator('#login-password').fill(value); await page.locator('#login-password').press('Enter'); await workbench(page, f); }
async function teamPage(page) { await page.locator('#team-link').click(); await page.locator('#account-name').waitFor({ state: 'visible' }); }
async function addMember(page, name, role) {
  if ((await page.locator('.team-add').getAttribute('open')) === null) await page.locator('.team-add summary').click();
  await page.locator('#member-name').fill(name); await page.locator('#member-password').fill(password); await page.locator('#member-role').selectOption(role); await page.locator('#member-form button[type=submit]').click();
  await page.locator('.team-member').filter({ has: page.locator('strong', { hasText: name }) }).waitFor({ state: 'visible' }); await page.waitForFunction(() => document.querySelector('#member-password').value === '');
}
async function noCredentialStorage(page) {
  const visible = await page.locator('body').innerText(), persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of [password, wrongPassword]) { assert.equal(visible.includes(value), false); assert.equal(persisted.includes(value), false); }
  assert.equal(await page.evaluate(() => document.cookie.includes('taskflow_session=')), false);
}
async function seed(f) {
  const owner = await f.app.teamAccess.setup({ name: 'owner', password });
  const reviewer = await f.app.teamAccess.createMember(owner.cookie, { name: 'reviewer', password, role: 'reviewer' });
  const observer = await f.app.teamAccess.createMember(owner.cookie, { name: 'observer', password, role: 'observer' }); return { owner, reviewer, observer };
}

for (const width of [1440, 390]) test(`real team ${width}px: setup, workbench, member creation, last owner, role/disable changes and logout`, async t => {
  const f = await fixture(t), page = await f.page(width); await openLogin(page, f); assert.equal(await page.locator('#login-name').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('#login-submit').innerText(), '设置并登录'); assert.equal(await page.locator('#login-password').getAttribute('type'), 'password');
  await login(page, f, '负责人'); assert.match(await page.locator('#team-link').innerText(), /负责人/u); await noCredentialStorage(page); await teamPage(page);
  await addMember(page, '评审成员', 'reviewer'); await addMember(page, '观察成员', 'observer'); assert.equal(await page.locator('.team-member').count(), 3);
  assert.equal(await page.locator('#member-password').inputValue(), ''); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); await noCredentialStorage(page);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(f.directory, `team-${width}.png`), fullPage: true });
  const ownerRow = page.locator('.team-member').filter({ has: page.locator('strong', { hasText: '负责人' }) }), ownerId = await ownerRow.getAttribute('data-member-id');
  page.expectedFailure(`/api/team/members/${ownerId}`, 409); await ownerRow.getByRole('combobox').selectOption('observer'); await ownerRow.getByRole('button', { name: '保存权限' }).click();
  await page.waitForFunction(() => document.querySelector('#team-error')?.textContent.includes('至少一位')); assert.equal(f.app.teamAccess.setupRequired(), false);
  await ownerRow.getByRole('combobox').selectOption('owner');
  const reviewerRow = page.locator('.team-member').filter({ has: page.locator('strong', { hasText: '评审成员' }) }); await reviewerRow.getByRole('combobox').selectOption('observer'); await reviewerRow.getByRole('button', { name: '保存权限' }).click();
  await page.waitForFunction(() => document.querySelector('#team-notice')?.textContent.includes('已核对保存后的权限')); assert.equal(await reviewerRow.getByRole('combobox').inputValue(), 'observer');
  const observerRow = page.locator('.team-member').filter({ has: page.locator('strong', { hasText: '观察成员' }) }); await observerRow.getByRole('checkbox').uncheck(); await observerRow.getByRole('button', { name: '保存权限' }).click(); await page.waitForFunction(() => !document.querySelector('#logout').disabled);
  assert.equal(await observerRow.getByRole('checkbox').isChecked(), false); await noCredentialStorage(page);
  await page.locator('#logout').click(); await page.locator('#team-login').waitFor({ state: 'visible' }); assert.equal(await page.locator('#login-name').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('#members').innerText(), ''); assert.equal(await page.locator('#audit-list').innerText(), ''); assert.equal(await page.locator('#team-account').isVisible(), false);
});

test('reviewer and observer login into the real workbench with their own role views and clear denied project mutations', async t => {
  const f = await fixture(t); await seed(f);
  for (const role of ['reviewer', 'observer']) {
    const page = await f.page(); await openLogin(page, f); await login(page, f, role); await teamPage(page); assert.equal(await page.locator('#member-admin').isVisible(), false); assert.equal(await page.locator('#team-audit').isVisible(), role === 'reviewer'); await noCredentialStorage(page);
    await page.goto(f.origin + '/'); await workbench(page, f); page.expectedFailure('/api/projects', 403); await page.locator('#new-project').click();
    await page.locator('#project-name-input').fill('被拒绝的团队修改'); await page.locator('#source-input').fill('用户可以查看资源列表。'); await page.locator('#create-project-button').click();
    await page.waitForFunction(() => document.querySelector('#import-error')?.textContent.includes('当前角色只可查看')); assert.equal(f.app.store.list().length, 0); await noCredentialStorage(page);
  }
});

test('role revocation and disable are reflected by the real workbench session/401 path without leaving an admitted project', async t => {
  const f = await fixture(t), users = await seed(f), page = await f.page(390); await openLogin(page, f); await login(page, f, 'reviewer');
  f.app.teamAccess.updateMember(users.owner.cookie, users.reviewer.id, { role: 'observer', active: true }); await page.locator('#refresh-button').click(); await page.waitForURL(f.origin + '/team.html'); await page.locator('#team-login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#login-name').evaluate(node => node === document.activeElement), true); await login(page, f, 'reviewer'); assert.match(await page.locator('#team-link').innerText(), /观察者/u);
  await page.locator('#new-project').click(); await page.locator('#project-name-input').fill('已撤权不能保存'); await page.locator('#source-input').fill('用户可以查看资源列表。');
  f.app.teamAccess.updateMember(users.owner.cookie, users.reviewer.id, { role: 'observer', active: false }); page.expectedFailure('/api/projects', 401); await page.locator('#create-project-button').click();
  await page.waitForURL(f.origin + '/team.html'); await page.locator('#team-login').waitFor({ state: 'visible' }); assert.equal(f.app.store.list().length, 0); await noCredentialStorage(page);
});

test('losing authentication on the team page focuses login without publishing the pending member', async t => {
  const f = await fixture(t), users = await seed(f), page = await f.page(); const backup = await f.app.teamAccess.createMember(users.owner.cookie, { name: 'backup', password, role: 'owner' }); const backupLogin = await f.app.teamAccess.login({ name: backup.name, password });
  await openLogin(page, f); await login(page, f, 'owner'); await teamPage(page); await page.locator('.team-add summary').click(); await page.locator('#member-name').fill('not-created'); await page.locator('#member-password').fill(password);
  f.app.teamAccess.updateMember(backupLogin.cookie, users.owner.user.id, { role: 'observer', active: true }); page.expectedFailure('/api/team/members', 401); await page.locator('#member-form button[type=submit]').click();
  await page.locator('#team-login').waitFor({ state: 'visible' }); assert.equal(await page.locator('#login-name').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('#member-password').inputValue(), '');
  assert.equal(await page.locator('#members').innerText(), ''); assert.equal(await page.locator('#audit-list').innerText(), ''); assert.equal(await page.locator('#account-name').innerText(), '');
  assert.equal(f.app.teamAccess.listMembers(backupLogin.cookie).some(user => user.name === 'not-created'), false); await noCredentialStorage(page);
});

test('wrong password remains masked, errors are text and keyboard focus stays in the active login form', async t => {
  const f = await fixture(t); await seed(f); const page = await f.page(390); await openLogin(page, f); await page.locator('#login-name').fill('owner'); await page.locator('#login-password').fill(wrongPassword);
  page.expectedFailure('/api/team/login', 401); await page.locator('#login-password').press('Enter'); await page.waitForFunction(() => document.querySelector('#team-error')?.textContent.includes('无效'));
  await page.waitForFunction(() => !document.querySelector('#login-submit').disabled); assert.equal(await page.locator('#login-password').getAttribute('type'), 'password'); assert.equal(await page.locator('#login-password').evaluate(node => node === document.activeElement), true);
  await noCredentialStorage(page); assert.equal(await page.locator('#team-error img, #team-error script').count(), 0); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
});

test('disabled team mode preserves the unauthenticated workbench and local project creation', async t => {
  const f = await fixture(t, false), page = await f.page(390); await page.goto(f.origin + '/'); await workbench(page, f); assert.equal(await page.locator('#team-link').isVisible(), false);
  await page.locator('#new-project').click(); await page.locator('#project-name-input').fill('本地模式项目'); await page.locator('#source-input').fill('用户可以查看资源列表。'); await page.locator('#create-project-button').click();
  await page.waitForFunction(() => !document.querySelector('#project-dialog').open); assert.equal(f.app.store.list().length, 1); assert.equal(page.url(), f.origin + '/');
  await page.goto(f.origin + '/team.html'); await page.waitForFunction(() => document.querySelector('#team-description')?.textContent.includes('本地单人模式')); assert.equal(await page.locator('#team-login').isVisible(), false); assert.equal(await page.locator('#team-account').isVisible(), false); await noCredentialStorage(page);
  await page.getByRole('link', { name: '返回工作台', exact: true }).click(); await workbench(page, f);
});

test('a maximum-length team name remains reachable in the 390px workbench header', async t => {
  const f = await fixture(t), page = await f.page(390), name = '长'.repeat(48); await openLogin(page, f); await login(page, f, name);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); assert.equal(await page.locator('#team-link').getAttribute('title'), `${name}（负责人）`);
  const box = await page.locator('#refresh-button').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391);
  await page.screenshot({ path: path.join(f.directory, 'workbench-long-name-390.png') }); await teamPage(page); assert.match(await page.locator('#account-name').innerText(), /负责人/u); await noCredentialStorage(page);
});
