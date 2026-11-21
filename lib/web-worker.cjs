'use strict';
// Platform-owned transport only. No test verdict, command or host operation is accepted here.
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const MAX_BODY = 256 * 1024;
const MAX_LINE = MAX_BODY * 6 + 32 * 1024;
const write = process.stdout.write.bind(process.stdout);
const stringify = JSON.stringify.bind(JSON);
const send = message => write(`${stringify(message)}\n`);
const writeError = process.stderr.write.bind(process.stderr), exit = process.exit.bind(process);
const ownDescriptor = Object.getOwnPropertyDescriptor;
const typeErrorPrototype = TypeError.prototype;
const prototypeOf = Object.getPrototypeOf;
const intrinsicError = Error, defineProperty = Object.defineProperty, apply = Reflect.apply, isArray = Array.isArray;
let nativeStackGetter, nativeFrameFile, nativeFrameLine;
function withPlatformFrames(work) {
  const previous = ownDescriptor(intrinsicError, 'prepareStackTrace');
  try { defineProperty(intrinsicError, 'prepareStackTrace', { configurable: true, writable: true, value: (_error, frames) => frames }); return work(); }
  finally { if (previous) defineProperty(intrinsicError, 'prepareStackTrace', previous); else delete intrinsicError.prepareStackTrace; }
}
withPlatformFrames(() => {
  const sample = new intrinsicError(), field = ownDescriptor(sample, 'stack');
  nativeStackGetter = field?.get;
  const frames = nativeStackGetter ? apply(nativeStackGetter, sample, []) : null;
  if (isArray(frames) && frames[0]) { nativeFrameFile = frames[0].getFileName; nativeFrameLine = frames[0].getLineNumber; }
});
let startupPhase = 'module', startupCode = null, applicationReady = false;

// Only snapshotted candidate modules can contribute a location. Error text and
// stack are untrusted input: they are inspected locally, never serialized.
function moduleSnapshot() {
  const modules = [];
  let bytes = 0;
  const visit = relative => {
    const absolute = path.resolve(relative);
    if (!fs.existsSync(absolute)) return;
    for (const item of fs.readdirSync(absolute, { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) { visit(name); continue; }
      if (!item.isFile() || name.length > 200 || !/^[A-Za-z0-9_./-]+\.(?:mjs|cjs|js)$/u.test(name)) continue;
      const filename = path.resolve(name), content = fs.readFileSync(filename, 'utf8');
      bytes += Buffer.byteLength(content);
      if (modules.length >= 256 || bytes > 2 * 1024 * 1024) throw new Error('module snapshot limit');
      modules.push({ name, filename, url: pathToFileURL(filename).href, lines: content.split(/\r\n?|\n/u) });
    }
  };
  try { for (const root of ['src', 'public', 'migrations', 'tests', 'docs']) visit(root); }
  catch { return []; }
  return modules;
}
const startupModules = moduleSnapshot();
function startupDiagnostic(cause) {
  let message = '', location;
  try {
    const text = ownDescriptor(cause, 'message')?.value;
    if (typeof text === 'string' && text.length <= 160) message = text;
    // Use V8's original lazy-stack accessor with a platform-owned formatter.
    // Never call candidate stack getters/prepareStackTrace or parse forged text.
    const field = ownDescriptor(cause, 'stack');
    if (nativeStackGetter && field?.get === nativeStackGetter) withPlatformFrames(() => {
      const frames = apply(nativeStackGetter, cause, []);
      if (!isArray(frames)) return;
      for (let index = 0; index < frames.length && index < 40; index++) {
        const filename = apply(nativeFrameFile, frames[index], []), line = apply(nativeFrameLine, frames[index], []);
        for (const module of startupModules) {
          if ((filename === module.filename || filename === module.url) && Number.isSafeInteger(line) && line > 0
            && line <= module.lines.length && module.lines[line - 1].trim()) { location = { name: module.name, line, text: module.lines[line - 1] }; break; }
        }
        if (location) break;
      }
    });
  } catch { /* A hostile error object cannot add diagnostic content. */ }
  let code = startupCode ?? (startupPhase === 'module' ? 'application_module_failed' : 'application_initialization_failed');
  try {
    if (startupPhase === 'factory' && prototypeOf(cause) === typeErrorPrototype && location
      && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.transaction is not a function$/u.test(message)
      && /\.transaction\s*\(/u.test(location.text)) code = 'sqlite_transaction_unsupported';
  } catch { /* Classification remains a fixed generic category. */ }
  return { phase: 'startup', code, ...(location ? { sourceLocation: { name: location.name, line: location.line } } : {}) };
}

(async () => {
  const module = await import(pathToFileURL(path.resolve('src/app.mjs')).href);
  if (typeof module.createApp !== 'function') { startupCode = 'invalid_application_factory'; throw new Error('invalid application factory'); }
  startupPhase = 'factory';
  const app = await module.createApp({ databasePath: path.resolve('.platform/tmp/app.sqlite') });
  if (!app || typeof app.handle !== 'function') { startupCode = 'invalid_application_handler'; throw new Error('invalid application handler'); }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buffered = 0;
  // readline alone permits an unbounded line; bound raw input before it reaches the handler.
  process.stdin.on('data', chunk => {
    for (const byte of chunk) { buffered = byte === 10 ? 0 : buffered + 1; if (buffered > MAX_LINE) process.exit(2); }
  });
  applicationReady = true; send({ type: 'ready' });
  for await (const line of lines) {
    if (!line || Buffer.byteLength(line) > MAX_LINE) throw new Error('invalid request frame');
    const message = JSON.parse(line);
    if (message.type === 'stop' && Object.keys(message).length === 1) {
      if (typeof app.close === 'function') await app.close();
      send({ type: 'stopped' });
      lines.close();
      return;
    }
    if (message.type !== 'request' || typeof message.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(message.id)
      || !message.request || typeof message.request.body !== 'string' || Buffer.byteLength(message.request.body) > MAX_BODY) {
      throw new Error('invalid request message');
    }
    let response;
    try { response = await app.handle(message.request); }
    catch { response = { status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"Application request failed"}' }; }
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599
      || !(typeof response.body === 'string' || Buffer.isBuffer(response.body))) throw new Error('invalid application response');
    const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body, 'utf8');
    if (body.length > MAX_BODY) throw new Error('application response too large');
    send({ type: 'response', id: message.id, response: { status: response.status, headers: response.headers ?? {}, bodyBase64: body.toString('base64') } });
  }
  // EOF is a stop, never an implicit application success.
  if (typeof app.close === 'function') await app.close();
})().catch(cause => {
  let frame = null;
  try {
    if (!applicationReady) {
      const diagnostic = startupDiagnostic(cause), location = diagnostic.sourceLocation;
      // Serialize only validated scalar values, without consulting candidate
      // toJSON hooks or exposing any property from the original exception.
      frame = '{"type":"startup_error","diagnostic":{"phase":"startup","code":' + stringify(diagnostic.code)
        + (location ? ',"sourceLocation":{"name":' + stringify(location.name) + ',"line":' + location.line + '}' : '') + '}}\n';
    }
  } catch { /* Diagnostics cannot replace the original failed startup. */ }
  const failed = () => writeError('Web bridge worker failed.\n', () => exit(2));
  if (frame) write(frame, failed); else failed();
});
