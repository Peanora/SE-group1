import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const marker = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
const fixture = () => ({ current: { revision: a, generation: 1, source: { filename: 'original.md', content: 'original body' } }, versions: [{ revision: a, generation: 1, source: { filename: 'original.md' } }], changes: [], capabilities: { canApply: true } });
const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><main style="max-width:1000px;margin:auto"><div id="panel"></div></main><script type="module">
import {createSourceChanges} from '/source-changes.js';
window.ctx={projectId:'a'};window.states={a:${JSON.stringify(fixture())},b:${JSON.stringify(fixture())}};
window.requests=[];window.errors=[];window.applied=[];window.holds={};window.pending=[];window.mode={};window.saved=new Map();window.counter=0;
window.release=async(index, options={})=>{const p=window.pending[index];if(options.error){p.reject(Object.assign(new Error(options.error),{status:options.status}));return;}try{p.resolve(options.response??await p.execute());}catch(e){p.reject(e);}};
const api=(url,options={})=>{
 const method=options.method||'GET',pid=decodeURIComponent(url.split('/')[3]),body=options.body?JSON.parse(options.body):null;
 window.requests.push({url,method,body});const snapshot=structuredClone(window.states[pid]);
 const execute=async()=>{
  const state=window.states[pid];
  if(method==='GET'){if(window.mode.getStatus)throw Object.assign(new Error('读取失败，请刷新核对'),{status:window.mode.getStatus});return snapshot;}
  if(url.endsWith('/parse')){if(window.mode.parseStatus)throw Object.assign(new Error('文件解析失败'),{status:window.mode.parseStatus});return {source:window.mode.parsed??{filename:body.filename,content:body.content??'parsed docx'}};}
  if(url.endsWith('/apply')){
   if(window.mode.applyStatus)throw Object.assign(new Error('项目仍忙，请等待安全检查点'),{status:window.mode.applyStatus});
   const id=decodeURIComponent(url.split('/').at(-2)),change=state.changes.find(x=>x.id===id);
   if(window.mode.applyMode==='pending')return {change:structuredClone(change)};
   const result={...change,status:'applied',appliedGeneration:state.current.generation+1};
   if(window.mode.applyMode!=='responseOnly'){Object.assign(change,result);state.current={revision:change.sourceRevision,generation:result.appliedGeneration,source:change.source};state.versions.push(structuredClone(state.current));}
   if(window.mode.applyThenFail)throw Object.assign(new Error('应用已发送，结果不确定'),{status:503});
   if(window.mode.holdConfirmation)window.holds['GET:'+pid]=1;
   return {change:result};
  }
  if(window.mode.postStatus)throw Object.assign(new Error('保存失败，草稿已保留'),{status:window.mode.postStatus});
  const key=pid+':'+body.requestKey;let change=window.saved.get(key);
  if(!change){change={...body,id:'change-'+(++window.counter),projectId:pid,generation:state.current.generation,sourceRevision:'${b}',status:'pending',createdAt:'2026-11-14T00:00:00Z',draft:{reason:body.reason,kind:body.kind,changes:{blocks:[{type:'modify',oldStartLine:1,newStartLine:1,removed:state.current.source.content,added:body.source.content}]},impact:{requiresMigrationReview:true}}};window.saved.set(key,change);state.changes.push(change);}
  if(window.mode.saveThenFail){window.mode.saveThenFail=false;throw new TypeError('连接中断，结果不确定');}
  return {change:structuredClone(change)};
 };
 const key=method+':'+pid;if(window.holds[key]){window.holds[key]--;return new Promise((resolve,reject)=>window.pending.push({url,method,body,execute,resolve,reject}));}
 return execute();
};
window.panel=createSourceChanges({api,getContext:()=>window.ctx,onApplied:x=>{window.applied.push(structuredClone(x));if(window.mode.callbackFails)return Promise.reject(new Error('parent refresh failed'));},onError:e=>window.errors.push(e.message)});
await window.panel.mount(document.querySelector('#panel'));window.ready=true;
</script></body></html>`;
let browser, server, address;
before(async () => {
  const module = await readFile(new URL('../public/source-changes.js', import.meta.url));
  server = http.createServer((req, res) => { if (req.url === '/source-changes.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(module); } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(harness); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); address = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function pageFor(t, viewport = { width: 1440, height: 1000 }) {
  const page = await browser.newPage({ viewport }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  t.after(async () => { assert.deepEqual(errors, [], 'browser console must stay clean'); await page.close(); });
  await page.goto(address); await page.waitForFunction(() => window.ready); return page;
}
const save = page => page.getByRole('button', { name: '保存为待应用变更', exact: true });
const apply = page => page.getByRole('button', { name: '应用为新需求版本', exact: true });
const body = page => page.getByLabel('需求正文', { exact: true });
const reason = page => page.getByLabel('变更原因', { exact: true });
const refresh = page => page.evaluate(() => window.panel.refresh());
async function edit(page, content = 'changed body') { await body(page).fill(content); await reason(page).fill('new requirement'); }
async function saved(page) { await page.waitForFunction(() => window.states.a.changes.length > 0 && document.querySelector('.source-changes button.sc-primary')?.textContent === '保存为待应用变更'); }

test('save has an exact idempotent body, pending history and text-only conservative differences', async t => {
  const page = await pageFor(t); await edit(page, marker); await page.getByLabel('变更分类（仅标签）').selectOption('workflow'); await save(page).click(); await saved(page);
  const request = await page.evaluate(() => window.requests.find(x => x.method === 'POST'));
  assert.equal(request.url, '/api/projects/a/changes'); assert.deepEqual(Object.keys(request.body).sort(), ['baseRevision', 'kind', 'reason', 'requestKey', 'source']);
  assert.equal(request.body.baseRevision, a); assert.deepEqual(request.body.source, { filename: 'original.md', content: marker }); assert.equal(request.body.kind, 'workflow');
  assert.match(request.body.requestKey, /^[a-z0-9-]+$/); assert.equal(await page.evaluate(() => window.applied.length), 0);
  assert.match(await page.locator('.source-changes').innerText(), /待应用/); assert.match(await page.locator('.source-changes').innerText(), /旧 passed 结果不复用/);
  assert.match(await page.locator('.source-changes').innerText(), /需要单独审阅数据迁移/); assert.equal(await page.locator('.source-changes img, .source-changes script').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await body(page).inputValue(), marker); assert.equal(await apply(page).isEnabled(), true);
});

test('400, 409 and 503 preserve input and the same-body request key; edits create a new key', async t => {
  const page = await pageFor(t); await edit(page); let key;
  for (const status of [400, 409, 503]) {
    await page.evaluate(status => { window.mode.postStatus = status; }, status); await save(page).click(); await page.getByRole('alert').waitFor({ state: 'visible' });
    const request = await page.evaluate(() => window.requests.filter(x => x.method === 'POST').at(-1)); if (key) assert.equal(request.body.requestKey, key); key = request.body.requestKey;
    assert.equal(await body(page).inputValue(), 'changed body'); assert.equal(await reason(page).inputValue(), 'new requirement'); assert.equal(await page.evaluate(() => window.states.a.current.revision), a);
  }
  await body(page).dispatchEvent('input'); await page.evaluate(() => { window.mode.postStatus = 0; }); await save(page).click(); await saved(page);
  assert.equal(await page.evaluate(() => window.requests.filter(x => x.method === 'POST').at(-1).body.requestKey), key);
  await body(page).fill('another body'); await save(page).click(); await page.waitForFunction(() => window.states.a.changes.length === 2);
  assert.notEqual(await page.evaluate(() => window.requests.filter(x => x.method === 'POST').at(-1).body.requestKey), key);
});

test('uncertain saved response refreshes history and retries without creating a second request, including reload', async t => {
  const page = await pageFor(t); await edit(page); await page.evaluate(() => { window.mode.saveThenFail = true; }); await save(page).click(); await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.match(await page.locator('.source-changes').innerText(), /结果尚不确定/); const key = await page.evaluate(() => window.requests.find(x => x.method === 'POST').body.requestKey);
  await refresh(page); assert.equal(await page.getByLabel('选择变更记录').locator('option').count(), 1);
  await page.reload(); await page.waitForFunction(() => window.ready); assert.equal(await body(page).inputValue(), 'changed body');
  // Reload resets the trusted test server state, but must preserve the browser's original request key.
  await save(page).click(); await saved(page); assert.equal(await page.evaluate(() => window.requests.find(x => x.method === 'POST').body.requestKey), key);
  await save(page).click(); await saved(page); assert.equal(await page.evaluate(() => window.states.a.changes.length), 1);
});

test('apply waits for an actual applied response AND a matching current-version GET; busy keeps the draft', async t => {
  const page = await pageFor(t); await edit(page); await save(page).click(); await saved(page);
  for (const mode of ['pending', 'responseOnly']) {
    await page.evaluate(mode => { window.mode.applyMode = mode; }, mode); await apply(page).click(); await page.getByRole('alert').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.applied.length), 0); assert.equal(await page.evaluate(() => window.states.a.current.revision), a); assert.equal(await apply(page).isEnabled(), true);
  }
  await page.evaluate(() => { window.mode.applyMode = ''; window.mode.applyStatus = 409; }); await apply(page).click(); await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.equal(await body(page).inputValue(), 'changed body'); assert.match(await page.getByRole('alert').innerText(), /安全检查点/);
  await page.evaluate(() => { window.mode.applyStatus = 0; }); await apply(page).click(); await page.waitForFunction(() => window.applied.length === 1);
  const request = await page.evaluate(() => window.requests.filter(x => x.url.endsWith('/apply')).at(-1)); assert.deepEqual(request.body, { baseRevision: a, generation: 1 });
  assert.equal(await apply(page).isDisabled(), true); assert.match(await page.locator('.source-changes').innerText(), /新规格和计划需重新确认/); assert.match(await page.locator('.source-changes').innerText(), /代码与数据库迁移尚未执行/);
});

test('a changed current version keeps old draft and blocks save/apply; missing capabilities and legacy fields fail closed', async t => {
  const page = await pageFor(t); await edit(page); await save(page).click(); await saved(page);
  await page.evaluate(({ revision }) => { window.states.a.current = { revision, generation: 2, source: { filename: 'new.md', content: 'new current text' } }; }, { revision: c }); await refresh(page);
  assert.equal(await body(page).inputValue(), 'changed body'); assert.equal(await save(page).isDisabled(), true); assert.equal(await apply(page).isDisabled(), true); assert.match(await page.locator('.source-changes').innerText(), /草稿基于旧输入版本/);
  await page.getByRole('button', { name: '基于当前版本重新编辑' }).click(); assert.equal(await body(page).inputValue(), 'new current text'); assert.equal(await save(page).isEnabled(), true); assert.equal(await apply(page).isDisabled(), true);
  await page.evaluate(() => { window.states.a.changes[0].baseRevision = window.states.a.current.revision; window.states.a.changes[0].generation = window.states.a.current.generation; }); await refresh(page); assert.equal(await apply(page).isEnabled(), true);
  await page.evaluate(() => { delete window.states.a.capabilities; }); await refresh(page); assert.equal(await apply(page).isDisabled(), true);
  await page.evaluate(() => { window.states.a.capabilities = { canApply: 'true' }; }); await refresh(page); assert.equal(await apply(page).isDisabled(), true);
  await page.evaluate(() => { window.states.a = { changes: [], versions: {} }; }); await refresh(page); assert.equal(await save(page).isDisabled(), true); assert.match(await page.locator('.source-changes').innerText(), /版本信息不完整/);
});

test('refresh and poll preserve DOM focus, selection, details and session drafts at desktop and 390px', async t => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await pageFor(t, viewport); await edit(page, 'a precise edited document'); await save(page).click(); await saved(page);
    await page.getByText('输入版本历史', { exact: true }).click(); await body(page).focus();
    await body(page).evaluate(el => { el.setSelectionRange(2, 9); window.savedTextarea = el; });
    await refresh(page); await page.waitForTimeout(3100);
    const beforeReload = await body(page).evaluate(el => ({ same: el === window.savedTextarea, focus: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd, text: el.value, open: [...document.querySelectorAll('.source-changes details')].map(x => x.open), overflow: document.documentElement.scrollWidth > innerWidth }));
    assert.deepEqual(beforeReload, { same: true, focus: true, start: 2, end: 9, text: 'a precise edited document', open: [true, true], overflow: false });
    const dir = new URL('../output/verification/source-changes-panel/', import.meta.url); await mkdir(dir, { recursive: true }); await page.screenshot({ path: fileURLToPath(new URL(`${viewport.width}.png`, dir)), fullPage: true });
    await page.reload(); await page.waitForFunction(() => window.ready); assert.equal(await body(page).inputValue(), 'a precise edited document'); assert.equal(await reason(page).inputValue(), 'new requirement');
  }
});

test('file import sends text or DOCX bytes only to parse and preserves text on parser errors or in-flight edits', async t => {
  const page = await pageFor(t); await edit(page, 'keep old text'); const file = page.getByLabel('导入 MD / TXT / DOCX（最大 3 MiB）');
  await file.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('imported text') }); await page.getByRole('button', { name: '导入文件到草稿' }).click(); await page.waitForFunction(() => document.querySelector('textarea').value === 'imported text');
  const request = await page.evaluate(() => window.requests.find(x => x.url.endsWith('/parse'))); assert.deepEqual(request.body, { filename: 'notes.txt', content: 'imported text' }); assert.equal(await page.evaluate(() => window.states.a.changes.length), 0);
  await page.evaluate(() => { window.mode.parseStatus = 400; }); await file.setInputFiles({ name: 'bad.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('bad zip') }); await page.getByRole('button', { name: '导入文件到草稿' }).click(); await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.equal(await body(page).inputValue(), 'imported text'); assert.equal(await page.evaluate(() => window.requests.filter(x => x.url.endsWith('/parse')).at(-1).body.fileBase64), Buffer.from('bad zip').toString('base64'));
  await page.evaluate(() => { window.mode.parseStatus = 0; window.holds['POST:a'] = 1; }); await page.getByRole('button', { name: '导入文件到草稿' }).click(); await page.waitForFunction(() => window.pending.length === 1); await body(page).fill('newer typed text'); await page.evaluate(() => window.release(0));
  await page.waitForFunction(() => document.querySelector('[role=alert]').textContent.includes('草稿已编辑')); assert.equal(await body(page).inputValue(), 'newer typed text');
  const count = await page.evaluate(() => window.requests.length); await file.setInputFiles({ name: 'large.docx', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3 * 1024 * 1024 + 1) }); await page.getByRole('button', { name: '导入文件到草稿' }).click();
  await page.waitForFunction(() => document.querySelector('[role=alert]').textContent.includes('3 MiB')); assert.equal(await page.evaluate(() => window.requests.length), count);
});

test('old project save success/error/finally cannot replace or unlock a new project action, including ABA', async t => {
  for (const failure of [false, true]) {
    const page = await pageFor(t); await edit(page, 'A draft'); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await save(page).click(); await page.waitForFunction(() => window.pending.length === 1);
    await page.evaluate(async () => { window.ctx.projectId = 'b'; await window.panel.refresh(); }); await edit(page, 'B draft'); await page.evaluate(() => { window.holds['POST:b'] = 1; }); await save(page).click(); await page.waitForFunction(() => window.pending.length === 2);
    await page.evaluate(failure => window.release(0, failure ? { error: 'old A failure', status: 409 } : {}), failure);
    assert.equal(await body(page).inputValue(), 'B draft'); assert.equal(await page.getByRole('button', { name: '正在保存，等待后端确认…' }).isDisabled(), true); assert.equal(await page.getByRole('alert').isVisible(), false);
    await page.evaluate(() => window.release(1)); await page.waitForFunction(() => window.states.b.changes.length === 1); await page.waitForFunction(() => document.querySelector('button.sc-primary').textContent === '保存为待应用变更');
    await page.evaluate(async () => { window.ctx.projectId = 'a'; await window.panel.refresh(); }); assert.equal(await body(page).inputValue(), 'A draft');
    const posts = await page.evaluate(() => window.requests.filter(x => x.method === 'POST')); assert.equal(posts.length, 2); assert.equal(posts[1].url, '/api/projects/b/changes');
  }
});

test('late GETs cannot publish after project ABA or after destroy; empty selection has a clear state', async t => {
  const page = await pageFor(t); await page.evaluate(() => { window.holds['GET:a'] = 1; window.oldRefresh = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(async revision => { window.ctx.projectId = 'b'; await window.panel.refresh(); window.states.a.current = { revision, generation: 4, source: { filename: 'A newest.md', content: 'A newest' } }; window.ctx.projectId = 'a'; await window.panel.refresh(); }, c);
  await page.evaluate(async () => { await window.release(0); await window.oldRefresh; }); assert.equal(await body(page).inputValue(), 'original body');
  assert.match(await page.locator('.source-changes').innerText(), new RegExp(c)); assert.match(await page.locator('.source-changes').innerText(), /A newest.md/); assert.equal(await save(page).isDisabled(), true);
  // The old draft is retained; current revision/filename must come from the latest response.
  assert.equal(await page.evaluate(() => window.requests.filter(x => x.method === 'GET').length), 4);
  await page.evaluate(async () => { window.ctx = {}; await window.panel.refresh(); }); assert.match(await page.locator('.source-changes').innerText(), /请先选择项目/); assert.equal(await body(page).isVisible(), false);
  await page.evaluate(async () => { window.ctx.projectId = 'a'; await window.panel.refresh(); window.holds['GET:a'] = 1; window.last = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 2);
  await page.evaluate(async () => { window.panel.destroy(); await window.release(1); await window.last; }); assert.equal(await page.locator('.source-changes').count(), 0); assert.equal(await page.evaluate(() => window.applied.length), 0);
});

test('the old A POST remains stale after A→B→A and cannot unlock the new A request', async t => {
  const page = await pageFor(t); await edit(page, 'first A'); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await save(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  const oldKey = await page.evaluate(() => window.pending[0].body.requestKey);
  await page.evaluate(async () => { window.ctx.projectId = 'b'; await window.panel.refresh(); window.ctx.projectId = 'a'; await window.panel.refresh(); });
  assert.equal(await body(page).inputValue(), 'first A'); assert.match(await page.locator('.source-changes').innerText(), /结果尚不确定/);
  await body(page).fill('second A'); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await save(page).click(); await page.waitForFunction(() => window.pending.length === 2);
  assert.notEqual(await page.evaluate(() => window.pending[1].body.requestKey), oldKey);
  await page.evaluate(() => window.release(0, { error: 'old epoch A error', status: 503 }));
  assert.equal(await body(page).inputValue(), 'second A'); assert.equal(await page.getByRole('button', { name: '正在保存，等待后端确认…' }).isDisabled(), true); assert.equal(await page.getByRole('alert').isVisible(), false);
  assert.equal(await page.evaluate(() => window.errors.length), 0); await page.evaluate(() => window.release(1)); await saved(page);
});

test('applied, interrupted and unknown history remains visible but cannot apply; busy reason and parser success are backend text', async t => {
  const page = await pageFor(t); await edit(page); await save(page).click(); await saved(page);
  await page.evaluate(marker => { const source = window.states.a.changes[0]; window.states.a.changes = ['applied','apply_interrupted','applying','unrecognized'].map((status,index)=>({...source,id:'history-'+index,status,error:status==='apply_interrupted'?marker:null})); window.states.a.capabilities={canApply:false,reason:'执行尚未确认停止，当前不可应用'}; }, marker); await refresh(page);
  for (const id of ['history-0', 'history-1', 'history-2', 'history-3']) { await page.getByLabel('选择变更记录').selectOption(id); assert.equal(await apply(page).isDisabled(), true); }
  await page.getByLabel('选择变更记录').selectOption('history-1'); assert.match(await page.locator('.source-changes').innerText(), /应用中断/); assert.equal(await page.locator('.source-changes img').count(), 0);
  assert.match(await page.locator('.source-changes').innerText(), /执行尚未确认停止/);
  await page.getByLabel('导入 MD / TXT / DOCX（最大 3 MiB）').setInputFiles({ name: 'contract.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('trusted parser transport fixture') });
  await page.getByRole('button', { name: '导入文件到草稿' }).click(); await page.waitForFunction(() => document.querySelector('textarea').value === 'parsed docx');
  assert.equal(await page.getByLabel('需求文件名', { exact: true }).inputValue(), 'contract.docx'); assert.equal(await page.evaluate(() => window.applied.length), 0);
});

test('failed state reads withdraw application permission and same-project older refreshes cannot restore it', async t => {
  const page = await pageFor(t); await edit(page); await save(page).click(); await saved(page); assert.equal(await apply(page).isEnabled(), true);
  await body(page).focus(); await page.evaluate(() => { window.mode.getStatus = 503; }); await refresh(page);
  assert.equal(await apply(page).isDisabled(), true); assert.equal(await body(page).inputValue(), 'changed body'); assert.equal(await body(page).evaluate(el => document.activeElement === el), true);
  await page.evaluate(() => { window.mode.getStatus = 0; }); await refresh(page); assert.equal(await apply(page).isEnabled(), true);
  await page.evaluate(() => { window.holds['GET:a'] = 1; window.oldRead = window.panel.refresh(); }); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(async revision => { window.states.a.current = { revision, generation: 8, source: { filename: 'latest.md', content: 'latest text' } }; await window.panel.refresh(); }, c);
  await page.evaluate(async () => { await window.release(0); await window.oldRead; }); assert.match(await page.locator('.source-changes').innerText(), new RegExp(c)); assert.equal(await apply(page).isDisabled(), true); assert.equal(await save(page).isDisabled(), true);
});

test('an applied response from an abandoned project cannot notify or change the current project', async t => {
  const page = await pageFor(t); await edit(page); await save(page).click(); await saved(page);
  await page.evaluate(() => { window.holds['POST:a'] = 1; }); await apply(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(async () => { window.ctx.projectId = 'b'; await window.panel.refresh(); }); await edit(page, 'keep B input');
  await page.evaluate(() => window.release(0)); assert.equal(await body(page).inputValue(), 'keep B input'); assert.equal(await page.evaluate(() => window.applied.length), 0); assert.equal(await page.evaluate(() => window.states.b.current.revision), a);
  assert.equal(await save(page).isEnabled(), true); assert.equal(await page.getByRole('alert').isVisible(), false);
  await page.evaluate(async () => { window.ctx.projectId = 'a'; await window.panel.refresh(); }); assert.equal(await page.evaluate(() => window.applied.length), 0, 'an abandoned epoch cannot later notify from historical applied data');
});

test('a newer confirmation GET can notify once while the apply-owned GET is pending, without a late false error', async t => {
  const page = await pageFor(t); await edit(page); await save(page).click(); await saved(page);
  await page.evaluate(() => { window.mode.holdConfirmation = true; }); await apply(page).click(); await page.waitForFunction(() => window.pending.length === 1);
  await refresh(page); assert.equal(await page.evaluate(() => window.applied.length), 1);
  assert.match(await page.locator('.source-changes').innerText(), /后端已确认新输入版本/);
  await page.getByRole('button', { name: '基于当前版本重新编辑' }).click(); await edit(page, 'a subsequent draft'); await page.evaluate(() => { window.holds['POST:a'] = 1; }); await save(page).click(); await page.waitForFunction(() => window.pending.length === 2);
  await page.evaluate(() => window.release(0)); assert.equal(await page.getByRole('button', { name: '正在保存，等待后端确认…' }).isDisabled(), true); assert.equal(await body(page).inputValue(), 'a subsequent draft');
  assert.equal(await page.getByRole('alert').isVisible(), false); assert.deepEqual(await page.evaluate(() => window.errors), []);
  await page.evaluate(() => window.release(1)); await page.waitForFunction(() => document.querySelector('button.sc-primary').textContent === '保存为待应用变更');
  await refresh(page); assert.equal(await page.evaluate(() => window.applied.length), 1);
});

test('an unknown apply POST can recover from matching GET evidence only, with exact binding and one notification', async t => {
  const page = await pageFor(t); await edit(page); await save(page).click(); await saved(page);
  await page.evaluate(() => { window.mode.applyThenFail = true; }); await apply(page).click(); await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.applied.length), 0);
  for (const mismatch of ['projectId', 'id', 'baseRevision', 'generation', 'sourceRevision', 'appliedGeneration', 'currentRevision', 'currentGeneration']) {
    await page.evaluate(mismatch => {
      const state=window.states.a;window.restoreState=structuredClone(state);
      if(mismatch==='currentRevision')state.current.revision='c'.repeat(64);
      else if(mismatch==='currentGeneration')state.current.generation=9;
      else state.changes[0][mismatch]=({projectId:'b',id:'other-change',baseRevision:'c'.repeat(64),generation:8,sourceRevision:'c'.repeat(64),appliedGeneration:9})[mismatch];
    }, mismatch);
    await refresh(page); assert.equal(await page.evaluate(() => window.applied.length), 0, mismatch);
    await page.evaluate(() => { window.states.a = window.restoreState; });
  }
  await refresh(page); assert.equal(await page.evaluate(() => window.applied.length), 1); assert.equal(await page.getByRole('alert').isVisible(), false);
  await refresh(page); assert.equal(await page.evaluate(() => window.applied.length), 1); assert.equal(await page.evaluate(() => window.requests.filter(x=>x.url.endsWith('/apply')).length), 1);
});

test('a parent callback failure preserves confirmed application and is not notified again on refresh', async t => {
  const page = await pageFor(t); await edit(page); await save(page).click(); await saved(page);
  await page.evaluate(() => { window.mode.callbackFails = true; }); await apply(page).click(); await page.waitForFunction(() => window.applied.length === 1); await page.getByRole('alert').waitFor({ state: 'visible' });
  assert.match(await page.getByRole('alert').innerText(), /需求已应用/); assert.equal(await page.evaluate(() => window.states.a.changes[0].status), 'applied');
  await refresh(page); assert.equal(await page.evaluate(() => window.applied.length), 1); assert.equal(await apply(page).isDisabled(), true);
});
