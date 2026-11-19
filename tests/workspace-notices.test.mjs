import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>
*{box-sizing:border-box}body{margin:0;padding:20px;font:16px/1.6 sans-serif}main{padding-top:2700px;padding-bottom:500px}textarea{display:block;width:100%;max-width:450px;height:100px}button{padding:8px;min-height:40px}#toast,.workspace-notice{position:fixed;left:16px;right:16px;bottom:16px;max-width:560px;max-height:40dvh;overflow:auto;padding:16px;background:#fff4f2;border:1px solid #c25b4f;z-index:200}#toast{bottom:48vh;background:#eef7f1}#error-text{display:block;white-space:pre-wrap;overflow-wrap:anywhere}.workspace-notice[data-expanded="false"] #error-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.workspace-notice-actions{display:flex;gap:8px;flex-wrap:wrap}dialog{width:330px;max-width:calc(100% - 24px)}[hidden]{display:none!important}
</style></head><body><section id="notice-home"><div id="error-banner" role="alert" hidden><span id="error-text"></span><button id="dismiss-error">关闭错误提示</button></div></section><main><textarea id="work-input">尚未保存的填写内容</textarea><button id="target">当前操作</button></main><dialog id="edit-dialog"><label>对话框输入<textarea id="modal-input">对话框草稿</textarea></label><button id="modal-close">关闭对话框</button></dialog><dialog id="second-dialog"><textarea id="second-input">第二层草稿</textarea></dialog><div id="toast" role="status" hidden></div><script type="module">
import {createWorkspaceNotices} from '/workspace-notices.js';
window.context={projectId:'p1',runId:'r1'};window.locations=[];
window.notes=createWorkspaceNotices({errorBanner:document.querySelector('#error-banner'),errorText:document.querySelector('#error-text'),dismissButton:document.querySelector('#dismiss-error'),toast:document.querySelector('#toast'),getContext:()=>window.context,locate:item=>{window.locations.push(JSON.parse(JSON.stringify({source:item.source,stageId:item.stageId,target:typeof item.target==='string'?item.target:item.target?.id})));if(window.holdLocate)return new Promise((resolve,reject)=>{window.rejectLocate=()=>reject(new Error('旧定位失败'));});}});
document.querySelector('#modal-close').onclick=()=>document.querySelector('#edit-dialog').close();window.ready=true;
</script></body></html>`;
const simulationHarness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="simulation-host"></div><aside id="simulation-detail"></aside><script type="module">
import {createSimulatedTasks} from '/simulated-tasks.js';
window.context={projectId:'p1',runId:'r1',planRevision:'plan1',current:true};window.simulationErrors=[];window.simulationSuccess=[];window.simulationFailures=[];window.simulationNotice='';window.simulationMode='reject';
const run={id:'s1',createdAt:'2026-11-17T00:00:00Z',planVersion:1,sourceRevision:'source1',planRevision:'plan1',status:'failed',concurrency:2,events:[],tasks:[{id:'A',status:'failed',reason:'当前模拟任务失败',attempts:[],requiresConfirmation:false,history:[]}]};
window.simulationRun=run;
const api=async(url,options={})=>{if(options.method==='POST'){if(window.simulationMode==='hold')return new Promise((resolve,reject)=>{window.releaseSimulation=()=>reject(new Error('旧项目的迟到模拟失败'));});if(window.simulationMode==='immediate-failure'){run.id='s2';run.status='failed';run.tasks[0].status='failed';run.tasks[0].reason='新运行执行后立即失败';run.tasks[0].attempts=[{number:1,status:'failed',summary:'新运行执行后立即失败'}];return structuredClone({simulation:run});}if(window.simulationMode==='success')return structuredClone({simulation:run});throw new Error('重试连接失败，当前任务未改变');}const snapshot=structuredClone({runs:window.context.projectId==='p1'?[run]:[],canStart:true,reason:''});if(window.holdSimulationRead){window.holdSimulationRead=false;return new Promise(resolve=>{window.releaseSimulationRead=()=>resolve(snapshot);});}return snapshot;};
window.simulation=createSimulatedTasks({api,getContext:()=>window.context,onError:error=>window.simulationErrors.push(error.message),onActionSuccess:info=>window.simulationSuccess.push(info),onFailure:info=>{window.simulationFailures.push(info);window.simulationNotice=info.message;},onUpdate:()=>{document.querySelector('#simulation-detail').innerHTML=window.simulation.detail('A');}});
window.simulation.mount(document.querySelector('#simulation-host'));document.addEventListener('click',event=>{if(event.target.closest('[data-simulation-action]'))window.simulationNotice='';},true);await window.simulation.refresh();window.ready=true;
</script></body></html>`;
let browser, server, address;
before(async () => {
  const module = await readFile(new URL('../public/workspace-notices.js', import.meta.url));
  const simulationModule = await readFile(new URL('../public/simulated-tasks.js', import.meta.url));
  server = http.createServer((request, response) => {
    const script = request.url === '/workspace-notices.js' ? module : request.url === '/simulated-tasks.js' ? simulationModule : null;
    response.writeHead(200, { 'Content-Type': script ? 'text/javascript' : 'text/html; charset=utf-8' });
    response.end(script || (request.url === '/simulation' ? simulationHarness : harness));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function pageFor(t, width = 1440, route = '') {
  const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  t.after(async () => { assert.deepEqual(errors, []); await page.close(); });
  await page.goto(address + route); await page.waitForFunction(() => window.ready); return page;
}

for (const width of [1440, 390]) test(`Edge ${width}px：滚动后的错误保持可见、不抢焦点且只有用户点击才定位`, { timeout: 30000 }, async t => {
  const page = await pageFor(t, width), input = page.locator('#work-input'), notice = page.locator('#error-banner');
  await input.evaluate(element => { element.scrollIntoView({ block: 'center' }); element.focus(); element.setSelectionRange(2, 5); });
  const before = await page.evaluate(() => ({ scroll: scrollY, value: document.querySelector('#work-input').value }));
  await page.evaluate(() => window.notes.error(new Error('保存失败，请核对当前任务后重试。'), { source: 'simulation', target: '#target' }));
  const box = await notice.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 901 && box.x >= 0 && box.x + box.width <= width + 1);
  assert.deepEqual(await input.evaluate(element => [document.activeElement === element, element.selectionStart, element.selectionEnd, element.value]), [true, 2, 5, before.value]);
  assert.equal(await page.evaluate(() => scrollY), before.scroll); assert.deepEqual(await page.evaluate(() => window.locations), []);
  await page.waitForTimeout(3900); assert.equal(await notice.isVisible(), true, '错误不跟随短暂成功提示自动消失');
  await page.getByRole('button', { name: '查看问题', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.locations), [{ source: 'simulation', target: '#target' }]);
  assert.equal(await page.evaluate(() => scrollY), before.scroll);
  const evidence = path.resolve('output/playwright/ui-notices'); await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `notice-${width}.png`) });
  await page.locator('#dismiss-error').click(); assert.equal(await notice.isHidden(), true);
});

test('长错误以纯文本展示，可展开收起，HTML不会执行或生成元素', async t => {
  const page = await pageFor(t), message = '<img src=x onerror="window.injected=true">\n'.repeat(20);
  await page.evaluate(message => window.notes.error(message, { source: 'source', target: document.querySelector('#target') }), message);
  assert.equal(await page.locator('#error-text').textContent(), message); assert.equal(await page.locator('#error-banner img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  const expand = page.locator('[data-notice-expand]'); assert.equal(await expand.getAttribute('aria-expanded'), 'false');
  await expand.click(); assert.equal(await expand.getAttribute('aria-expanded'), 'true');
  await page.evaluate(message => window.notes.error(message, { source: 'source', target: document.querySelector('#target') }), message);
  assert.equal(await expand.getAttribute('aria-expanded'), 'true', '重复读取同一错误不应收起正在阅读的详情');
  await expand.click(); assert.equal(await expand.getAttribute('aria-expanded'), 'false');
  await page.locator('[data-notice-locate]').click();
  assert.deepEqual(await page.evaluate(() => window.locations), [{ source: 'source', target: 'target' }]);
});

test('切项目和运行清理通知，显式旧上下文的迟到失败不重新出现', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => { window.notes.error('项目1失败'); window.notes.success('项目1保存完成'); window.context = { projectId: 'p2', runId: 'r2' }; window.notes.syncContext(); });
  assert.equal(await page.locator('#error-banner').isHidden(), true); assert.equal(await page.locator('#toast').isHidden(), true);
  assert.equal(await page.evaluate(() => window.notes.error('迟到失败', { context: { projectId: 'p1', runId: 'r1' } })), false);
  assert.equal(await page.locator('#error-banner').isHidden(), true);
  await page.evaluate(() => { window.notes.error('当前项目失败'); window.context.runId = 'r3'; window.notes.syncContext(); });
  assert.equal(await page.locator('#error-banner').isHidden(), true);
  assert.equal(await page.evaluate(() => window.notes.error('旧运行迟到失败', { context: { projectId: 'p2', runId: 'r2' } })), false);
  await page.evaluate(() => { window.holdLocate=true; window.notes.error('当前操作失败', { target:'#target' }); });
  await page.locator('[data-notice-locate]').click();
  await page.evaluate(() => { window.context={projectId:'p3',runId:'r4'}; window.notes.syncContext(); window.rejectLocate(); });
  await page.waitForTimeout(30); assert.equal(await page.locator('#error-banner').isHidden(), true);
});

test('规划失败使用真实阶段状态并按运行、阶段与尝试去重，关闭后不随轮询重现', async t => {
  const page = await pageFor(t), failure = { id: 'r1', status: 'failed', stages: [{ id: 'tasks', title: '拆解开发任务', status: 'failed', attempt: 1, error: '生成任务失败' }] };
  assert.equal(await page.evaluate(run => window.notes.failure(run), { ...failure, id: 'other-run' }), false);
  assert.equal(await page.evaluate(() => window.notes.failure({ id: 'r1', status: 'running', stages: [{ id: 'tasks', status: 'running', attempt: 1 }] })), false);
  assert.equal(await page.evaluate(run => window.notes.failure(run), failure), true);
  assert.match(await page.locator('#error-text').textContent(), /拆解开发任务.*生成任务失败/);
  await page.locator('[data-notice-locate]').click(); assert.deepEqual(await page.evaluate(() => window.locations), [{ source: 'planning', stageId: 'tasks' }]);
  await page.locator('#dismiss-error').click(); assert.equal(await page.evaluate(run => window.notes.failure(run), failure), false);
  assert.equal(await page.locator('#error-banner').isHidden(), true);
  failure.stages[0].attempt = 2; assert.equal(await page.evaluate(run => window.notes.failure(run), failure), true);
});

test('成功恢复只清理相同来源与上下文的错误，无参数和原生关闭事件保持兼容', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.notes.error('代码执行失败', { source:'execution' }));
  assert.equal(await page.evaluate(() => window.notes.clear({ source:'source' })), false);
  assert.equal(await page.locator('#error-banner').isVisible(), true);
  assert.equal(await page.evaluate(() => window.notes.clear({ source:'execution',context:{projectId:'other',runId:'r1'} })), false);
  assert.match(await page.locator('#error-text').textContent(), /代码执行失败/);
  assert.equal(await page.evaluate(() => window.notes.clear({ source:'execution',context:window.context })), true);
  assert.equal(await page.locator('#error-banner').isHidden(), true);
  await page.evaluate(() => { window.notes.error('当前错误'); window.notes.clear(); });
  assert.equal(await page.locator('#error-banner').isHidden(), true);
  await page.evaluate(() => window.notes.error('再次失败')); await page.locator('#dismiss-error').click();
  assert.equal(await page.locator('#error-banner').isHidden(), true);
});

test('原生对话框中错误与成功通知处于最上层，关闭后恢复原宿主且不复制节点', async t => {
  const page = await pageFor(t, 390);
  await page.evaluate(() => document.querySelector('#edit-dialog').showModal());
  const input = page.locator('#modal-input'); await input.focus(); await input.evaluate(element => element.setSelectionRange(1, 4));
  await page.evaluate(() => { window.notes.error('对话框保存失败', { source: 'review' }); window.notes.success('草稿保留'); });
  assert.equal(await page.locator('#error-banner').evaluate(element => element.parentNode.id), 'edit-dialog');
  assert.equal(await page.locator('#toast').evaluate(element => element.parentNode.id), 'edit-dialog');
  assert.equal(await page.locator('#error-banner').isVisible(), true);
  assert.deepEqual(await input.evaluate(element => [document.activeElement === element, element.selectionStart, element.selectionEnd, element.value]), [true, 1, 4, '对话框草稿']);
  assert.equal(await page.locator('#error-banner').evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.left + 20, rect.top + 20)); }), true);
  await page.evaluate(() => document.querySelector('#second-dialog').showModal());
  await page.waitForFunction(() => document.querySelector('#error-banner').parentNode.id === 'second-dialog');
  await page.evaluate(() => document.querySelector('#second-dialog').close());
  await page.waitForFunction(() => document.querySelector('#error-banner').parentNode.id === 'edit-dialog');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#error-banner').parentNode.id === 'notice-home');
  assert.equal(await page.locator('#error-banner').count(), 1); assert.equal(await page.locator('#toast').count(), 1);
  assert.equal(await page.locator('#toast').evaluate(element => element.parentNode.tagName), 'BODY');
});

test('模拟动作失败在当前操作与任务旁保留，轮询不吞错，切换上下文后清理并拒绝迟到错误', async t => {
  const page = await pageFor(t, 390, '/simulation');
  await page.getByRole('button', { name: '重试此模拟任务', exact: true }).click();
  await page.locator('[data-simulation-task-error]').waitFor();
  assert.match(await page.locator('[data-simulation-task-error]').textContent(), /重试连接失败/);
  assert.match(await page.locator('[data-simulation-error]').textContent(), /重试连接失败/);
  assert.deepEqual(await page.evaluate(() => window.simulationErrors), ['重试连接失败，当前任务未改变']);
  await page.evaluate(() => window.simulation.refresh());
  assert.equal(await page.locator('[data-simulation-task-error]').isVisible(), true);
  await page.evaluate(async () => { window.context={projectId:'p2',runId:'r2',planRevision:'plan2',current:true}; await window.simulation.refresh(); });
  assert.equal(await page.locator('[data-simulation-error]').count(), 0); assert.equal(await page.locator('[data-simulation-task-error]').count(), 0);
  await page.evaluate(async () => { window.context={projectId:'p1',runId:'r1',planRevision:'plan1',current:true}; window.simulationMode='hold'; await window.simulation.refresh(); });
  await page.getByRole('button', { name: '重试此模拟任务', exact: true }).click(); await page.waitForFunction(() => typeof window.releaseSimulation === 'function');
  await page.evaluate(async () => { window.context={projectId:'p2',runId:'r2',planRevision:'plan2',current:true}; await window.simulation.refresh(); window.context={projectId:'p1',runId:'r1',planRevision:'plan1',current:true}; await window.simulation.refresh(); window.releaseSimulation(); });
  await page.waitForFunction(() => !document.querySelector('[data-simulation-action="start"]').disabled);
  assert.equal(await page.locator('[data-simulation-error]').count(), 0); assert.equal(await page.locator('[data-simulation-task-error]').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.simulationErrors), ['重试连接失败，当前任务未改变']);
  assert.deepEqual(await page.evaluate(() => window.simulationSuccess), []);
  await page.evaluate(() => { window.simulationMode='success'; });
  await page.getByRole('button', { name: '重试此模拟任务', exact: true }).click();
  await page.waitForFunction(() => window.simulationSuccess.length === 1);
  assert.deepEqual(await page.evaluate(() => window.simulationSuccess), [{ action:'retry',taskId:'A',projectId:'p1',runId:'r1' }]);
  assert.equal(await page.locator('[data-simulation-task-error]').count(), 0);
});

test('模拟后台真实失败去重，不从成功任务的历史误报，旧上下文的GET不能通知', async t => {
  const page = await pageFor(t, 390, '/simulation');
  assert.equal(await page.evaluate(() => window.simulationFailures.length), 1);
  assert.deepEqual(await page.evaluate(() => window.simulationFailures[0].context), { projectId:'p1',runId:'r1' });
  assert.match(await page.evaluate(() => window.simulationFailures[0].message), /任务 A.*当前模拟任务失败/);
  await page.evaluate(async () => { await window.simulation.refresh(); await window.simulation.refresh(); });
  assert.equal(await page.evaluate(() => window.simulationFailures.length), 1);
  await page.evaluate(async () => { const task=window.simulationRun.tasks[0];task.status='completed';task.reason='当前已完成';task.attempts=[{number:1,status:'failed',summary:'已经解决的历史失败'},{number:2,status:'completed',summary:'成功'}];window.simulationRun.status='completed';await window.simulation.refresh(); });
  assert.equal(await page.evaluate(() => window.simulationFailures.length), 1);
  await page.evaluate(async () => { const task=window.simulationRun.tasks[0];task.status='failed';task.reason='新尝试失败';task.attempts.push({number:3,status:'failed',summary:'新尝试失败'});window.simulationRun.status='failed';await window.simulation.refresh(); });
  assert.equal(await page.evaluate(() => window.simulationFailures.length), 2);
  assert.notEqual(await page.evaluate(() => window.simulationFailures[0].id), await page.evaluate(() => window.simulationFailures[1].id));
  await page.evaluate(() => { window.simulationRun.tasks[0].reason='旧读取中的新错误';window.holdSimulationRead=true;window.pendingSimulationRead=window.simulation.refresh(); });
  await page.waitForFunction(() => typeof window.releaseSimulationRead === 'function');
  await page.evaluate(async () => { window.context={projectId:'p2',runId:'r2',planRevision:'plan2',current:true};await window.simulation.refresh();window.releaseSimulationRead();await window.pendingSimulationRead; });
  assert.equal(await page.evaluate(() => window.simulationFailures.length), 2);
});

test('网络中断明确提示结果待核对，不把未知结果描述成未保存', async t => {
  const page = await pageFor(t, 390);
  await page.evaluate(() => window.notes.error(new TypeError('Failed to fetch'), { source: 'source' }));
  const message = await page.locator('#error-text').textContent();
  assert.match(message, /暂时无法连接本地服务/);
  assert.match(message, /结果尚未确认/);
  assert.match(message, /刷新核对/);
  assert.doesNotMatch(message, /未保存成功|保存失败|Failed to fetch/);
});

test('启动动作HTTP成功但新模拟立即failed时，失败提示保留而不把动作成功当任务成功', async t => {
  const page = await pageFor(t, 390, '/simulation');
  await page.evaluate(() => { window.simulationMode='immediate-failure'; });
  await page.getByRole('button', { name:'启动模拟编排',exact:true }).click();
  await page.waitForFunction(() => window.simulationSuccess.length === 1 && window.simulationFailures.length === 2);
  assert.match(await page.evaluate(() => window.simulationNotice), /新运行执行后立即失败/);
  assert.equal(await page.evaluate(() => window.simulation.selection().status), 'failed');
  assert.equal(await page.evaluate(() => window.simulationFailures.at(-1).taskId), 'A');
  await page.evaluate(() => window.simulation.refresh());
  assert.equal(await page.evaluate(() => window.simulationFailures.length), 2);
  assert.match(await page.evaluate(() => window.simulationNotice), /新运行执行后立即失败/);
});
