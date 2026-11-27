import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

test('actual model-mode controls disclose specification budgets and refuse a service that omits them', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'specification-usage-browser-'));
  let calls = 0;
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, specificationMaxCalls: 2, specificationTimeoutMs: 1000,
    planner: { ...planner, getModelConfig: () => ({ configured: true, model: 'usage-ui-fixture' }), analyzeWithModel: () => { calls++; assert.fail('仅核对预算披露，不调用模型'); } } });
  const project = await app.store.create({ name: '规格预算界面', source: { filename: 'r.md', content: '用户读取资源。' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => { await browser.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('specification-usage-browser-')); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  await page.route('**/api/health', async route => { const response = await route.fetch(), body = await response.json(); delete body.modelPlanning.specificationMaxCalls; delete body.modelPlanning.specificationTimeoutMs; await route.fulfill({ response, json: body }); });
  await page.goto(url + '/?view=details'); await page.waitForFunction(() => !document.querySelector('#start-run').disabled);
  await page.locator('#mode-select').selectOption('model');
  assert.equal(await page.locator('#start-run').isDisabled(), true); assert.match(await page.locator('#planning-model-notice').textContent(), /规格调用次数未知/);
  await page.locator('#mode-select').selectOption('local'); assert.equal(await page.locator('#start-run').isEnabled(), true);
  await page.unroute('**/api/health'); await page.reload(); await page.waitForFunction(() => !document.querySelector('#start-run').disabled);
  await page.locator('#mode-select').selectOption('model'); assert.equal(await page.locator('#start-run').isEnabled(), true);
  assert.match(await page.locator('#planning-model-notice').textContent(), /规格最多调用 2 次.*单次整理规格最多 1 秒/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const health = await (await fetch(url + '/api/health')).json();
  assert.equal(health.modelPlanning.specificationMaxCalls, 2); assert.equal(health.modelPlanning.specificationTimeoutMs, 1000);
  await page.route('**/api/health', async route => { const response = await route.fetch(), body = await response.json(); body.modelPlanning.engineeringCallLimit = false; body.modelPlanning.engineeringMaxCalls = 6; await route.fulfill({ response, json: body }); });
  await page.reload(); await page.locator('#mode-select').selectOption('model'); await page.waitForFunction(() => document.querySelector('#planning-model-notice').textContent.includes('工程调用次数未知'));
  assert.equal(await page.locator('#start-run').isDisabled(), true); await page.locator('#mode-select').selectOption('local'); assert.equal(await page.locator('#start-run').isEnabled(), true);
  assert.equal(calls, 0); assert.equal(app.store.get(project.id).runs.length, 0); assert.deepEqual(errors, []);
});

test('unknown native planning transport has clear waiting controls on desktop and narrow Edge', {timeout:60000}, async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'planning-unknown-ui-')),config={baseUrl:'https://fixture.invalid/v1',model:'unknown-ui',apiKey:'synthetic-ui-key'};let calls=0;
 const app=await createApp({dataDir:directory,stepDelayMs:0,teamEnabled:false,planner:{...planner,getModelConfig:()=>({configured:true,model:config.model}),analyzeWithModel:(text,name,input)=>planner.analyzeWithModel(text,name,{...input,config,fetchImpl:async()=>{calls++;throw new Error('explicit free reset fixture')}})}});
 const project=await app.store.create({name:'未知请求界面',source:{filename:'r.md',content:'用户读取事项。'}}),other=await app.store.create({name:'独立普通项目',source:{filename:'r.md',content:'用户读取另一项目。'}}),run=await app.orchestrator.createRun(project.id,{mode:'model'});const end=Date.now()+5000;while(run.status!=='failed'||app.orchestrator.state(run).active.size){assert.ok(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,5))}
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});t.after(async()=>{await browser.close();await app.close();await rm(directory,{recursive:true,force:true})});await mkdir('output/planning-transport-budget',{recursive:true});
 for(const width of [1440,390]){const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});await page.goto('http://127.0.0.1:'+app.server.address().port+'/?view=details');await page.locator('#project-menu-trigger').click();await page.locator('[data-project="'+project.id+'"]').click();await page.waitForFunction(()=>document.querySelector('#planning-model-notice').textContent.includes('前次规划请求'));
  await page.waitForFunction(id=>document.querySelector('[data-delete-project="'+id+'"]')?.disabled===false,other.id);
  assert.equal(await page.locator('#start-run').isDisabled(),true);assert.equal(await page.locator('[data-delete-project="'+project.id+'"]').isDisabled(),true);assert.equal(await page.locator('[data-delete-project="'+other.id+'"]').isEnabled(),true);await page.locator('#workspace-tab-plan').click();await page.locator('[data-stage="spec"]').click();assert.equal(await page.getByRole('button',{name:'前次请求待核对',exact:true}).isDisabled(),true);assert.match(await page.locator('#stage-inspector').textContent(),/本地结束不表示远端已停/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await page.screenshot({path:'output/planning-transport-budget/unknown-'+width+'.png',fullPage:true});await page.close();
 }assert.equal(calls,1);assert.equal(run.specificationCalls,1);
});
