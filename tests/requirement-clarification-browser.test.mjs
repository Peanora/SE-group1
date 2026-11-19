import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { createApp } from '../server.mjs';
import * as planner from '../lib/planner.mjs';

async function openWorkflow(page) {
  if (!await page.locator('#workflow-details').evaluate(element => element.open)) await page.locator('#workflow-details > summary').click();
}

for (const width of [1440, 390]) test(`Edge ${width}px：一句话需求可澄清、保存刷新、继续生成新规格`, { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskflow-clarification-browser-'));
  const source = '我想做一个类似微信的聊天软件';
  const raw = { title: '聊天软件', summary: '首版范围待补充', goals: ['聊天软件'], roles: [], acceptanceScenarios: [], constraints: [], assumptions: [], requirements: [], questions: ['目标平台是什么？', '首版需要哪些功能？'], stack: { frontend: '待确认', backend: '待确认', storage: '待确认' } };
  let calls = 0, received;
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: { ...planner,
    getModelConfig: () => ({ configured: true, model: 'clarification-mock' }),
    analyzeWithModel: (text, name, options) => planner.analyzeWithModel(text, name, { ...options, config: { baseUrl: 'http://localhost', model: 'clarification-mock', apiKey: '' }, fetchImpl: async () => {
      calls++; received = text;
      const final = { ...raw, summary: '首版聊天范围', questions: [], requirements: [{ title: '文字聊天', description: '首版支持文字聊天', sourceQuote: '首版只做文字聊天', acceptance: ['用户可以发送和接收文字消息'] }] };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls === 1 ? raw : final) } }] }));
    } }) } });
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: '微信', source: { filename: 'requirements.md', content: source } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height: 950 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.goto(url + '/?view=details'); await page.locator('#mode-select').selectOption('model'); await page.locator('#start-run').click();
  await page.getByRole('heading', { name: '需要补充需求信息', exact: true }).waitFor();
  await openWorkflow(page);
  assert.match(await page.locator('#run-status').innerText(), /等待补充需求/);
  const specNode = page.locator('[data-stage="spec"]');
  assert.match(await specNode.getAttribute('class'), /awaiting-confirmation/u);
  assert.doesNotMatch(await specNode.getAttribute('class'), /(?:^|\s)succeeded(?:\s|$)/u);
  assert.match(await specNode.innerText(), /等待补充需求/u);
  assert.match(await page.locator('#run-progress').innerText(), /整理设计规格等待补充/u);
  await specNode.click();
  assert.match(await page.locator('#stage-inspector .status-tag').innerText(), /等待补充需求/u);
  assert.match(await page.locator('#stage-inspector').innerText(), /等待补充后生成最终规格/u);
  assert.equal(await page.getByRole('button', { name: '根据回答整理规格', exact: true }).isDisabled(), true);
  await page.getByLabel(/Q-001/).fill('Web网页'); await page.getByLabel(/Q-002/).fill('首版只做文字聊天');
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  // Disabled alone also describes an in-flight save. Wait for the visible
  // follow-up action to be usable before reloading the persisted version.
  await page.waitForFunction(() => document.querySelector('[data-review-action="save"]').disabled
    && !document.querySelector('[data-review-action="approve"]').disabled);
  assert.equal(calls, 1);
  await page.reload(); await page.getByRole('heading', { name: '需要补充需求信息', exact: true }).waitFor();
  assert.equal(await page.getByLabel(/Q-002/).inputValue(), '首版只做文字聊天');
  assert.match(await page.locator('#review-banner').innerText(), /新增一次模型请求/);
  await page.getByRole('button', { name: '根据回答整理规格', exact: true }).click();
  await page.getByRole('heading', { name: '先确认规格，再生成开发计划', exact: true }).waitFor();
  assert.match(await page.locator('[data-stage="spec"]').getAttribute('class'), /(?:^|\s)succeeded(?:\s|$)/u);
  await openWorkflow(page);
  await page.locator('[data-stage="spec"]').click();
  assert.match(await page.locator('#stage-inspector .status-tag').innerText(), /已完成/u);
  assert.equal(calls, 2); assert.ok(received.includes('首版只做文字聊天'));
  const run = app.store.get(project.id).runs[0];
  assert.equal(run.status, 'awaiting_spec'); assert.equal(run.approvals.spec, null); assert.equal(run.sourceSnapshot.content, source);
  assert.equal(await page.getByRole('button', { name: '确认规格并继续', exact: true }).isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(errors, []);
});

for (const width of [1440,390]) test(`Edge ${width}px：旧失败显示原因、禁用耗尽重试，并可免费重新校验`, { timeout:45000 }, async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'taskflow-failure-browser-'));let calls=0,browser;
  const raw={title:'客户端',summary:'Windows客户端',goals:[],roles:[],acceptanceScenarios:[],constraints:[],assumptions:[],questions:[],requirements:[{title:'客户端',description:'Windows客户端',sourceQuote:'Windows',acceptance:['可以启动']}],stack:{frontend:'待确认',backend:'待确认',storage:'待确认'}};
  const app=await createApp({dataDir:directory,stepDelayMs:0,specificationMaxCalls:1,planner:{...planner,getModelConfig:()=>({configured:true,model:'mock'}),analyzeWithModel:async(text,name,options)=>{
    await planner.analyzeWithModel(text,name,{...options,config:{baseUrl:'http://localhost',model:'mock',apiKey:''},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]}));}});
    throw new Error('legacy validator failure');
  }}});
  t.after(async()=>{await browser?.close();await app.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});});
  const project=await app.store.create({name:'旧校验失败',source:{filename:'requirements.md',content:'Windows客户端'}});
  const run=await app.orchestrator.createRun(project.id,{mode:'model'});
  for(let n=0;run.status!=='failed'||app.orchestrator.state(run).active.size||app.orchestrator.state(run).driving;n++){if(n>500)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}
  const old=structuredClone(run.specificationHistory);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}/?view=details`);
  await openWorkflow(page);
  await page.getByRole('button',{name:'重新校验已保存响应（不调用模型）',exact:true}).waitFor();
  assert.match(await page.locator('#stage-inspector').innerText(),/引用格式校验/);
  assert.equal(await page.getByRole('button',{name:'调用次数已用尽',exact:true}).isDisabled(),true);
  await page.reload();await openWorkflow(page);await page.getByRole('button',{name:'重新校验已保存响应（不调用模型）',exact:true}).click();
  await page.getByRole('heading',{name:'先确认规格，再生成开发计划',exact:true}).waitFor();
  await page.locator('.workspace-budget > summary').click();
  assert.match(await page.locator('#planning-model-notice').innerText(),/已免费重新校验/);
  assert.equal(calls,1);assert.equal(run.specificationCalls,1);assert.deepEqual(run.specificationHistory,old);assert.equal(run.approvals.spec,null);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);
});
