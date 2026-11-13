import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { guardModelContent, modelContentGuardPolicy } from '../lib/model-content-guard.mjs';

const unicode = value => value.split('').map(letter => '\\u' + letter.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const secret = 'synthetic-key/only';

test('literal and escaped JSON string values/keys redact the entire response', () => {
  for (const content of [secret, JSON.stringify(secret), `{"value":"${unicode(secret)}"}`, `{"${unicode(secret)}":"safe"}`,
    JSON.stringify({ value: secret }).replaceAll('/', '\\/'), `{"value":"${unicode(secret.slice(0, 5))}${secret.slice(5)}"}`,
    `{"value":"${unicode(secret)}","other":"${secret}"}`]) {
    const result = guardModelContent(content, secret);
    assert.deepEqual(result, { credentialResponse: true, content: '[REDACTED]' });
    assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(result.content.includes(unicode(secret)), false);
  }
});

test('valid JSON escapes for quotes, backslashes, controls and surrogate pairs are decoded once', () => {
  for (const key of ['quote"slash\\value/', 'token\n\t\b\f\r-end', 'token-🚀-中文']) {
    for (const content of [JSON.stringify({ value: key }).replaceAll('/', '\\/'), `{"${unicode(key)}":null}`]) assert.equal(guardModelContent(content, key).credentialResponse, true);
  }
});

test('complete escaped strings inside truncated or otherwise invalid JSON are still protected', () => {
  for (const content of [`{"value":"${unicode(secret)}",`, `not-json ["${unicode(secret)}"]`, `{"broken":"\\q","next":"${unicode(secret)}"}`]) {
    assert.equal(guardModelContent(content, secret).credentialResponse, true);
  }
});

test('stray quote and escape prefixes/suffixes cannot misalign credential detection', () => {
  const leaking = `{"value":"${unicode(secret)}"}`, safe = '{"value":"safe/value"}';
  const prefixes = ['"', '""', '"""', "'", '\\', '\\"', '\\\\', '\\\\"', '"\\', '"\\\\', '\\u0022', 'noise"'];
  const suffixes = ['', '"', '""', "'", '\\', '\\"', '\\\\', '"\\u0022'];
  for (const prefix of prefixes) for (const suffix of suffixes) {
    const content = prefix + leaking + suffix; assert.equal(content.includes(secret), false);
    assert.deepEqual(guardModelContent(content, secret), { credentialResponse: true, content: '[REDACTED]' });
    const nonleaking = prefix + safe + suffix;
    assert.deepEqual(guardModelContent(nonleaking, secret), { credentialResponse: false, content: nonleaking });
  }
});

test('backslash parity decodes exactly one layer despite malformed surrounding quotes', () => {
  for (let count = 1; count <= 6; count++) {
    const token = '"' + '\\'.repeat(count) + 'u' + secret.charCodeAt(0).toString(16).padStart(4, '0') + unicode(secret.slice(1)) + '"';
    const expected = JSON.parse(token).includes(secret);
    for (const prefix of ['', '"', '\\"', '"\\']) assert.equal(guardModelContent(prefix + token + '"\\', secret).credentialResponse, expected);
    assert.equal(expected, count % 2 === 1);
  }
});

test('maximum-role quote/escape noise stays bounded without overlapping reparses', { timeout: 5000 }, () => {
  const budget = 128 * 1024, tail = `{"value":"${unicode(secret)}"}`, chunk = '"\\u0041';
  const prefix = chunk.repeat(Math.floor((budget - tail.length) / chunk.length)), content = prefix + tail;
  assert.ok(content.length <= budget); assert.equal(guardModelContent(content, secret, budget).credentialResponse, true);
  const safe = prefix + '{"value":"safe"}'; assert.equal(guardModelContent(safe, secret, budget).content, safe);
});

test('normal and malformed nonleaking content is preserved byte for byte without repairing it', () => {
  for (const content of ['', ' \t\r\n ', '{"value":', '{"x":"\\q"}', '{"x":"unterminated', '{"text":"safe \\"}', '{"text":"safe \\\\\\" tail"}',
    '{"number":1e400}', JSON.stringify({ unrelated: 'safe/value', nested: [{ x: '普通中文' }], escaped: '\\u0041' })]) {
    assert.deepEqual(guardModelContent(content, secret), { credentialResponse: false, content });
  }
});

test('deep inputs are scanned without recursion; per-role byte and overall hard caps fail closed', { timeout: 5000 }, () => {
  const deep = '['.repeat(60000) + `"${unicode(secret)}"` + ']'.repeat(60000);
  assert.equal(guardModelContent(deep, secret, 128 * 1024).credentialResponse, true);
  const safeDeep = '['.repeat(60000) + '"safe"' + ']'.repeat(60000);
  assert.equal(guardModelContent(safeDeep, secret, 128 * 1024).content, safeDeep);
  for (const [content, cap] of [['x'.repeat(128 * 1024 + 1), 128 * 1024], ['中'.repeat(50000), 128 * 1024], ['x'.repeat(512 * 1024 + 1), 512 * 1024]]) assert.throws(() => guardModelContent(content, secret, cap), { code: 'content_inspection_limit' });
});

test('only primitive text inputs are accepted and no coercion/getter or code execution is possible', () => {
  let invoked = false; const malicious = { get toJSON() { invoked = true; throw new Error('getter must not run'); }, toString() { invoked = true; return secret; } };
  for (const args of [[malicious, secret], ['', malicious], ['', secret, malicious], ['', secret, 0], ['', secret, 524289]]) assert.throws(() => guardModelContent(...args), { code: 'invalid_content_guard' });
  assert.equal(invoked, false);
  globalThis.modelGuardExecuted = false;
  const text = '{"__proto__":{"poison":true},"constructor":"(() => {globalThis.modelGuardExecuted=true})()","toJSON":"throw new Error()"}';
  assert.equal(guardModelContent(text, secret).content, text); assert.equal(globalThis.modelGuardExecuted, false); assert.equal({}.poison, undefined); delete globalThis.modelGuardExecuted;
});

test('placeholders never contain unusual short credentials and empty credentials leave content unchanged', () => {
  for (const key of ['R', '[', 'REDACTED', '[REDACTED]', '!']) {
    const result = guardModelContent(JSON.stringify(key), key); assert.equal(result.credentialResponse, true); assert.equal(result.content.includes(key), false);
  }
  assert.equal(guardModelContent('"abc"', 'abc', 5).content, '');
  assert.deepEqual(guardModelContent('{"x":"safe"}', ''), { credentialResponse: false, content: '{"x":"safe"}' });
});

test('guard deliberately does not interpret base64, JS expressions or second-layer JSON strings', () => {
  for (const content of [JSON.stringify({ value: Buffer.from(secret).toString('base64') }), JSON.stringify({ value: unicode(secret) })]) {
    assert.deepEqual(guardModelContent(content, secret), { credentialResponse: false, content });
  }
});

test('helper policy hash binds its exact implementation bytes', async () => {
  const bytes = await readFile(new URL('../lib/model-content-guard.mjs', import.meta.url));
  assert.equal(modelContentGuardPolicy.hash, createHash('sha256').update(bytes).digest('hex')); assert.equal(Object.isFrozen(modelContentGuardPolicy), true);
});

test('Review policy changes with helper implementation hash or helper version', async () => {
  async function policy(version, hash) {
    const script = `import {mock} from 'node:test';mock.module(${JSON.stringify(new URL('../lib/model-content-guard.mjs', import.meta.url).href)},{namedExports:{guardModelContent:()=>{throw new Error('not called')},modelContentGuardPolicy:{version:${JSON.stringify(version)},hash:${JSON.stringify(hash)}}}});const{projectReviewPolicy}=await import(${JSON.stringify(new URL('../lib/project-review-model.mjs', import.meta.url).href)});process.stdout.write(projectReviewPolicy.hash);`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('trusted policy probe timed out')); }, 10000);
      child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; }); child.once('error', reject);
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(errors)); }); child.stdin.end(script);
    });
  }
  const results = await Promise.all([policy('v1', 'a'.repeat(64)), policy('v1', 'b'.repeat(64)), policy('v2', 'a'.repeat(64))]);
  for (const value of results) assert.match(value, /^[a-f0-9]{64}$/u); assert.equal(new Set(results).size, 3);
});
