import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { probeCreateAtStartup } from '../lib/planned-cold-start.mjs';

const step = { path: '/', loadPath: '/api/items', inputTestId: 'name', submitTestId: 'create', listTestId: 'items', countTestId: 'count', value: '第一条记录', expectedCount: 1 };

async function fixture(t) {
  let mode, rows = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      const disabled = mode === 'before-script' ? '' : ' disabled';
      response.setHeader('content-type', 'text/html; charset=utf-8');
      return response.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><link rel=icon href=data:,><form><input data-testid=name name=name${disabled}><button data-testid=create${disabled}>创建</button></form><p data-testid=count>0</p><ul data-testid=items></ul><script defer src=/main.js></script>`);
    }
    if (url.pathname === '/main.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      return response.end(`const form=document.querySelector('form');const input=document.querySelector('input');const button=document.querySelector('button');
const ready=()=>{input.disabled=false;button.disabled=false;};const render=rows=>{document.querySelector('ul').textContent=rows.map(row=>row.name).join(' ');document.querySelector('p').textContent=String(rows.length);};
form.addEventListener('submit',async event=>{event.preventDefault();const response=await fetch('/api/items',{method:'POST',body:JSON.stringify({name:input.value})});render(await response.json());});
${mode === 'before-data' ? 'ready();' : ''}fetch('/api/items').then(response=>response.json()).then(rows=>{render(rows);ready();});`);
    }
    if (url.pathname === '/api/items') {
      if (request.method === 'POST') {
        let body = '';
        for await (const part of request) body += part;
        rows.push(JSON.parse(body)); response.statusCode = 201;
      }
      response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify(rows));
    }
    response.statusCode = 404; response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return async (nextMode, width) => {
    mode = nextMode; rows = [];
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    try { return await probeCreateAtStartup({ context, origin, step }); }
    finally { await context.close(); }
  };
}

test('冷启动探针区分脚本未绑定、初始数据未到和首次提交成功', { timeout: 45000 }, async t => {
  const probe = await fixture(t);
  const nativeNavigation = await probe('before-script', 1440);
  assert.equal(nativeNavigation.code, 'form_available_before_script');
  assert.equal(nativeNavigation.earlyNavigation, true);
  assert.equal(nativeNavigation.posted, 0);
  const earlyData = await probe('before-data', 390);
  assert.equal(earlyData.code, 'form_available_before_data');
  assert.equal(earlyData.posted, 0);
  for (const width of [1440, 390]) {
    const result = await probe('ready-only', width);
    assert.deepEqual(result, { passed: true, blockedBeforeScript: true, blockedBeforeData: true, earlyNavigation: false, posted: 1, status: 201, faults: [] });
  }
});
