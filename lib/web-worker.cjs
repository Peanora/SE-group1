'use strict';
// Platform-owned transport only. No test verdict, command or host operation is accepted here.
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const MAX_BODY = 256 * 1024;
const MAX_LINE = MAX_BODY * 6 + 32 * 1024;
const write = process.stdout.write.bind(process.stdout);
const stringify = JSON.stringify.bind(JSON);
const send = message => write(`${stringify(message)}\n`);

(async () => {
  const module = await import(pathToFileURL(path.resolve('src/app.mjs')).href);
  if (typeof module.createApp !== 'function') throw new Error('invalid application factory');
  const app = await module.createApp({ databasePath: path.resolve('.platform/tmp/app.sqlite') });
  if (!app || typeof app.handle !== 'function') throw new Error('invalid application handler');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buffered = 0;
  // readline alone permits an unbounded line; bound raw input before it reaches the handler.
  process.stdin.on('data', chunk => {
    for (const byte of chunk) { buffered = byte === 10 ? 0 : buffered + 1; if (buffered > MAX_LINE) process.exit(2); }
  });
  send({ type: 'ready' });
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
})().catch(() => {
  process.stderr.write('Web bridge worker failed.\n', () => process.exit(2));
});
