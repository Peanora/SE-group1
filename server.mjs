import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { ProjectStore } from './lib/store.mjs';
import { Orchestrator } from './lib/orchestrator.mjs';
import { HttpError, parseDocument } from './lib/documents.mjs';
import { createZip } from './lib/zip.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST = 6 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function readJson(request) {
  if (!/^application\/json(?:;|$)/iu.test(request.headers['content-type'] ?? '')) throw new HttpError(400, '请使用 application/json 提交数据。');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST) throw new HttpError(400, '上传请求不能超过 6 MB。');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new HttpError(400, '请求不是有效的 JSON 对象。'); }
}

function respond(response, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...headers });
  response.end(bytes);
}

// Costly execution and its private records are local-workbench capabilities.
// Bind Host to the listening port as well as loopback to reject DNS rebinding.
function requireLocalExecutionRequest(request, server) {
  let target;
  try { target = new URL(`http://${request.headers.host}`); } catch { throw new HttpError(403, '请从本机工作台查看或操作代码执行。'); }
  const address = server.address();
  if (!address || typeof address !== 'object' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash
    || Number(target.port || 80) !== address.port || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
    throw new HttpError(403, '请从本机工作台查看或操作代码执行。');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请从本机工作台发起代码执行操作。');
}

function exactFields(body, fields) {
  if (Object.keys(body).length !== fields.length || fields.some(field => typeof body[field] !== 'string' || !body[field])) throw new HttpError(400, '执行请求字段无效，请刷新范围与状态后重试。');
  return body;
}

/** Load local dotenv values without dependencies, never overriding process variables. */
export async function loadEnv(filename = path.join(ROOT, '.env')) {
  let contents;
  try { contents = await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/u, '').trim();
    process.env[match[1]] = value;
  }
}

export async function createApp(options = {}) {
  const planner = options.planner ?? await import('./lib/planner.mjs');
  const store = options.store ?? await new ProjectStore(options.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT, 'data')).init();
  const orchestrator = new Orchestrator(store, planner, { stepDelayMs: options.stepDelayMs ?? process.env.WORKFLOW_STEP_DELAY_MS ?? 350 });
  const executionService = options.executionService === null ? null : options.executionService ?? await (await import('./lib/web-execution-service.mjs')).createWebExecutionService({
    rootDir: path.resolve(options.executionRootDir ?? path.join(store.directory, 'executions')),
    getPlanning: async (projectId, runId) => structuredClone(store.getRun(projectId, runId)),
  });
  try { await orchestrator.init(); }
  catch (cause) { try { await executionService?.shutdown(); } catch { cause.executionCleanupFailed = true; } throw cause; }
  let closing;
  const publicDir = path.resolve(options.publicDir ?? path.join(ROOT, 'public'));
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(request.url, 'http://localhost');
      let segments;
      try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new HttpError(400, '网址编码无效。'); }
      const method = request.method;
      if (segments[0] === 'api') {
        if (closing) throw new HttpError(503, '工作台正在停止，请稍后重新连接。');
        // No cross-site mutations to a local workspace. The app uses same-origin JSON.
        if (method !== 'GET' && method !== 'HEAD' && request.headers.origin) {
          let origin;
          try { origin = new URL(request.headers.origin); } catch { throw new HttpError(403, '请求来源无效。'); }
          if (origin.host !== request.headers.host || !['http:', 'https:'].includes(origin.protocol)) throw new HttpError(403, '请从本地工作台发起操作。');
        }
        if (method === 'GET' && segments.length === 2 && segments[1] === 'health') {
          const config = planner.getModelConfig();
          return respond(response, 200, { ok: true, model: { configured: config.configured, model: config.model ?? '' },
            modelPlanning: { engineeringMaxCalls: orchestrator.engineeringMaxCalls, engineeringTimeoutMs: orchestrator.engineeringTimeoutMs },
            supportedFormats: ['.md', '.txt', '.docx'] });
        }
        if (segments[1] !== 'projects') throw new HttpError(404, '未找到该接口。');
        if (segments.length === 2) {
          if (method === 'GET') return respond(response, 200, { projects: store.list() });
          if (method === 'POST') return respond(response, 201, { project: await store.create(parseDocument(await readJson(request))) });
          throw new HttpError(405, '该接口不支持此请求方法。');
        }
        const projectId = segments[2];
        if (segments.length === 3 && method === 'GET') return respond(response, 200, { project: store.get(projectId) });
        if (segments[3] !== 'runs') throw new HttpError(404, '未找到该接口。');
        if (segments.length === 4 && method === 'POST') return respond(response, 201, { run: await orchestrator.createRun(projectId, await readJson(request)) });
        const runId = segments[4];
        const { project, run } = store.getRun(projectId, runId);
        if (segments.length === 5 && method === 'GET') return respond(response, 200, { run });
        if (segments[5] === 'executions') {
          requireLocalExecutionRequest(request, server);
          if (!executionService) throw new HttpError(404, '当前服务尚未开放网页代码执行。');
          const identity = { projectId, runId };
          if (segments.length === 6) {
            if (method !== 'GET') throw new HttpError(405, '执行记录仅支持读取。');
            return respond(response, 200, await executionService.list(identity));
          }
          if (segments.length === 7 && segments[6] === 'start') {
            if (method !== 'POST') throw new HttpError(405, '启动执行请使用POST请求。');
            const body = exactFields(await readJson(request), ['profileId', 'contractRevision']);
            return respond(response, 202, await executionService.start({ ...identity, ...body }));
          }
          if (segments.length === 8 && segments[7] === 'action') {
            if (method !== 'POST') throw new HttpError(405, '执行动作请使用POST请求。');
            const input = await readJson(request);
            const body = exactFields(input, ['retry', 'recheck'].includes(input?.action) ? ['action', 'profileId', 'contractRevision'] : ['action']);
            if (!['cancel', 'retry', 'recheck', 'preview', 'stop_preview'].includes(body.action)) throw new HttpError(400, '执行动作无效，请刷新后使用页面提供的操作。');
            return respond(response, 200, await executionService.action({ ...identity, executionId: segments[6], ...body }));
          }
          if (segments.length === 8 && segments[7] === 'download') {
            if (method !== 'GET') throw new HttpError(405, '源码下载仅支持读取。');
            const file = await executionService.download({ ...identity, executionId: segments[6] });
            return respond(response, 200, file.buffer, file.contentType, {
              'Content-Disposition': `attachment; filename="verified-source.zip"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            });
          }
          throw new HttpError(404, '未找到该执行接口。');
        }
        if (segments.length === 6 && segments[5] === 'action' && method === 'POST') return respond(response, 200, { run: await orchestrator.action(projectId, runId, await readJson(request)) });
        if (segments.length === 7 && segments[5] === 'artifacts' && method === 'GET') {
          const artifact = run.artifacts.find(item => item.name === segments[6]);
          if (!artifact) throw new HttpError(404, '产物尚未生成或不存在。');
          const headers = url.searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename="${artifact.name}"` } : {};
          return respond(response, 200, artifact.content, artifact.name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', headers);
        }
        if (segments.length === 6 && segments[5] === 'download' && method === 'GET') {
          if (run.status !== 'succeeded') throw new HttpError(409, '请先完成审阅并确认导出。');
          const files = [{ name: 'requirements.md', content: (run.sourceSnapshot ?? project.source).content }, ...run.artifacts.map(({ name, content }) => ({ name, content }))];
          return respond(response, 200, createZip(files), 'application/zip', { 'Content-Disposition': `attachment; filename="project-documents.zip"; filename*=UTF-8''${encodeURIComponent(project.name)}.zip` });
        }
        throw new HttpError(404, '未找到该接口。');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, '静态文件仅支持读取。');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, '网址编码无效。'); }
      if (pathname.includes('\0')) throw new HttpError(400, '文件路径无效。');
      const file = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      const relative = path.relative(publicDir, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(403, '不可访问此文件。');
      let info;
      try { info = await stat(file); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new HttpError(404, '未找到该页面。'); throw error; }
      if (!info.isFile()) throw new HttpError(404, '未找到该页面。');
      const body = await readFile(file);
      if (method === 'HEAD') { response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length }); return response.end(); }
      respond(response, 200, body, MIME[path.extname(file)] ?? 'application/octet-stream');
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error('[server]', error.message);
      respond(response, status, { error: status >= 500 ? '服务处理失败，请查看服务端终端后重试。' : error.message });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  const close = () => {
    if (!closing) closing = (async () => {
      const results = await Promise.allSettled([orchestrator.shutdown(), executionService?.shutdown()]);
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    return closing;
  };
  return { server, store, orchestrator, executionService, close };
}

export async function startServer(options = {}) {
  if (options.loadEnv !== false) await loadEnv();
  const app = await createApp(options);
  const port = options.port ?? Number(process.env.PORT || 4317);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  try { await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, host, resolve); }); }
  catch (cause) { try { await app.close(); } catch { cause.executionCleanupFailed = true; } throw cause; }
  const address = app.server.address();
  return { ...app, url: `http://${host}:${address.port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().then(app => {
    console.log(`\n  需求编排工作台  ${app.url}\n  本地数据保存在 data/；按 Ctrl+C 停止。\n`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch(error => { console.error(`启动失败：${error.code === 'EADDRINUSE' ? '端口已被占用，请调整 .env 中的 PORT。' : error.message}`); process.exitCode = 1; });
}
