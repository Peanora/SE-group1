import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { roleCase, until } from './helpers/engineering-role-case.mjs';

for (const width of [1440, 390]) test(`actual ${width}px route-role editor preserves rejected drafts and saves a newly confirmed plan without another model`, { timeout: 90000 }, async t => {
  const f = await roleCase(t), project = await f.app.store.create({ name: '接口权限浏览器', source: { filename: 'r.md', content: '成员可以查看资源，审核者复核预约。' } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.goto(f.origin + '/?view=details'); await page.waitForFunction(() => document.querySelector('#start-run') && !document.querySelector('#start-run').disabled);
  await page.locator('#mode-select').selectOption('model'); await page.locator('#start-run').click();
  await page.getByRole('button', { name: '确认规格并继续', exact: true }).click();
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  const original = f.app.store.get(project.id).runs.at(-1), oldRevision = original.planRevision, route = `/api/projects/${project.id}/runs/${original.id}`;
  await page.locator('.engineering-role-editor > summary').click(); await page.locator('.engineering-role-editor .review-item > summary').click();
  const checkbox = page.locator('[data-route-index="0"][value="ROLE-002"]'), feedback = page.locator('[data-route-feedback]');
  await checkbox.uncheck(); await feedback.fill('审核者不应读取资源；只允许成员。');
  assert.equal(await page.locator('#approve-button').isDisabled(), true);
  await feedback.focus(); await feedback.evaluate(element => { element.setSelectionRange(2, 5); element.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.deepEqual(await feedback.evaluate(element => ({ focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd })), { focused: true, start: 2, end: 5 });
  let denied = false;
  await page.route('**/api/projects/*/runs/*/action', async intercepted => {
    const body = intercepted.request().postDataJSON();
    if (body.action === 'revise_route_roles' && !denied) { denied = true; await intercepted.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '独立测试：版本暂不可保存' }) }); }
    else await intercepted.continue();
  });
  await page.locator('[data-route-save]').click(); await page.waitForFunction(() => document.querySelector('[data-route-error]')?.textContent.includes('独立测试'));
  assert.equal(await checkbox.isChecked(), false); assert.equal(await feedback.inputValue(), '审核者不应读取资源；只允许成员。');
  await page.reload(); await page.waitForFunction(() => document.querySelector('[data-route-feedback]') && !document.querySelector('[data-route-feedback]').disabled);
  assert.equal(await page.locator('#approve-button').isDisabled(), true);
  assert.equal(await feedback.inputValue(), '审核者不应读取资源；只允许成员。'); assert.equal(await checkbox.isChecked(), false);
  await page.locator('[data-route-save]').click();
  const revised = await until(async () => { const r = (await f.request(route)).value.run; return r.status === 'awaiting_review' && r.planRevision !== oldRevision && r; });
  assert.deepEqual(revised.engineeringPlan.proposal.routes[0].roles, ['ROLE-001']); assert.equal(revised.approvals.plan, null);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
  await page.waitForFunction(() => document.querySelector('#approve-button') && !document.querySelector('#approve-button').disabled);
  const summary = page.locator('.engineering-role-editor > summary'); if (!await page.locator('.engineering-role-editor').evaluate(e => e.open)) await summary.click();
  if (!await page.locator('.engineering-role-editor .review-item').evaluate(e => e.open)) await page.locator('.engineering-role-editor .review-item > summary').click();
  assert.equal(await checkbox.isChecked(), false); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const output = path.resolve('output/engineering-role-revision'); await mkdir(output, { recursive: true });
  const shots = await mkdtemp(path.join(output, `browser-${width}-`)); await page.screenshot({ path: path.join(shots, 'saved.png'), fullPage: true });
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click(); await until(async () => (await f.request(route)).value.run.status === 'succeeded');
  assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
  assert.deepEqual(errors.filter(message => !message.includes('409 (Conflict)')), []);
});

test('fresh permission editor stays hidden with an older server capability and ordinary confirmation still works', { timeout: 60000 }, async t => {
  const f = await roleCase(t), { route } = await f.start();
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close()); const page = await browser.newPage();
  await page.route('**/api/health', async intercepted => { const response = await intercepted.fetch(), body = await response.json(); delete body.engineeringRoleRevision; await intercepted.fulfill({ response, json: body }); });
  await page.goto(f.origin + '/?view=details'); await page.getByRole('button', { name: '确认计划并导出', exact: true }).waitFor();
  assert.equal(await page.locator('.engineering-role-editor').count(), 0);
  await page.getByRole('button', { name: '确认计划并导出', exact: true }).click(); await until(async () => (await f.request(route)).value.run.status === 'succeeded');
  assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
});

test('reviewer can inspect engineering roles but the actual browser permission editor is read-only', { timeout: 60000 }, async t => {
  const f = await roleCase(t, { teamEnabled: true }); await f.start(); const password = 'Role-browser-reviewer-2026';
  assert.equal((await f.request('/api/team/members', { name: 'role-reviewer', password, role: 'reviewer' }, f.owner)).status, 201);
  const login = await f.request('/api/team/login', { name: 'role-reviewer', password }); assert.equal(login.status, 200);
  const cookie = login.cookie, split = cookie.indexOf('=');
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: f.origin, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); await page.goto(f.origin + '/?view=details'); await page.locator('.engineering-role-editor > summary').click();
  await page.locator('.engineering-role-editor .review-item > summary').click();
  assert.equal(await page.locator('[data-route-index]').first().isDisabled(), true); assert.equal(await page.locator('[data-route-save]').isDisabled(), true);
  assert.equal(await page.getByLabel('响应约定').isDisabled(), true);
  assert.match(await page.locator('[data-route-status]').textContent(), /当前账号只读/u); assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
});

test('actual narrow-screen contract editor saves request, response and role changes together', { timeout: 60000 }, async t => {
  const f = await roleCase(t), { run, route } = await f.start();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(f.origin + '/?view=details');
  await page.locator('.engineering-role-editor > summary').click();
  await page.locator('.engineering-role-editor .review-item > summary').click();
  const request = page.getByLabel('请求约定');
  const response = page.getByLabel('响应约定');
  await request.fill('无正文，允许page查询参数');
  await response.fill('200 {items,total}');
  await page.locator('[data-route-index="0"][value="ROLE-002"]').uncheck();
  assert.equal(await page.locator('#approve-button').isDisabled(), true);
  await page.reload();
  await response.waitFor({ state: 'attached' });
  assert.equal(await request.inputValue(), '无正文，允许page查询参数');
  assert.equal(await response.inputValue(), '200 {items,total}');
  assert.equal(await page.locator('#approve-button').isDisabled(), true);
  await page.locator('[data-route-save]').click();
  const revised = await until(async () => {
    const value = (await f.request(route)).value.run;
    return value.status === 'awaiting_review' && value.planRevision !== run.planRevision && value;
  });
  assert.deepEqual(revised.engineeringPlan.proposal.routes[0],
    { ...run.engineeringPlan.proposal.routes[0], request: '无正文，允许page查询参数', response: '200 {items,total}', roles: ['ROLE-001'] });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(revised.approvals.plan, null);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
  assert.deepEqual(errors, []);
});

test('same-version owner downgrade replaces unsaved role choices with saved read-only roles and preserves the owner draft', { timeout: 60000 }, async t => {
  const f = await roleCase(t), { run } = await f.start();
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(f.origin + '/?view=details');
  await page.evaluate(async run => {
    const { createEngineeringRouteRoles } = await import('/engineering-route-roles.js');
    const state = { run, actorRole: 'owner', health: { engineeringRoleRevision: { available: true }, teamAccess: { enabled: true } } };
    const host = document.createElement('div'); host.id = 'role-transition-probe'; host.style.cssText = 'position:fixed;inset:0;z-index:100000;background:white;overflow:auto'; document.body.append(host);
    const editor = createEngineeringRouteRoles({ getState: () => state, submit: () => { throw Error('This probe must not save'); }, refresh: async () => {}, toast: () => {} });
    window.roleTransitionProbe = { state, editor }; editor.mount(host);
  }, run);
  const host = page.locator('#role-transition-probe');
  await host.locator('.engineering-role-editor > summary').click(); await host.locator('.review-item > summary').click();
  const checkbox = host.locator('[data-route-index="0"][value="ROLE-002"]'); await checkbox.uncheck();
  await host.locator('[data-route-feedback]').fill('负责人尚未保存的草稿');
  assert.equal(await page.evaluate(() => window.roleTransitionProbe.editor.hasDirty()), true);
  await page.evaluate(() => { window.roleTransitionProbe.state.actorRole = 'reviewer'; window.roleTransitionProbe.editor.render(); });
  assert.equal(await checkbox.isChecked(), true, 'read-only display must reflect the saved plan');
  assert.equal(await checkbox.isDisabled(), true); assert.equal(await host.locator('[data-route-feedback]').inputValue(), '');
  assert.equal(await page.evaluate(() => window.roleTransitionProbe.editor.hasDirty()), false);
  await page.evaluate(() => { window.roleTransitionProbe.state.actorRole = 'owner'; window.roleTransitionProbe.editor.render(); });
  assert.equal(await checkbox.isChecked(), false); assert.equal(await checkbox.isDisabled(), false);
  assert.equal(await host.locator('[data-route-feedback]').inputValue(), '负责人尚未保存的草稿');
  assert.equal(await page.evaluate(() => window.roleTransitionProbe.editor.hasDirty()), true);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1 });
});
