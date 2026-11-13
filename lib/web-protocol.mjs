import { TextDecoder } from 'node:util';

export const MAX_WEB_BODY = 256 * 1024;
// A JSON string can expand a UTF-8 request character into a six-byte escape.
export const MAX_WEB_LINE = MAX_WEB_BODY * 6 + 32 * 1024;
export const WEB_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' http://localhost:* http://127.0.0.1:*";
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const APP_COOKIE = /^app_[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class WebRuntimeError extends Error {
  constructor(code, message, statusCode = 502) { super(message); this.name = 'WebRuntimeError'; this.code = code; this.statusCode = statusCode; }
}
const fail = (code, message, status = 400) => { throw new WebRuntimeError(code, message, status); };

function headerEntries(headers) {
  if (!plain(headers)) fail('invalid_headers', 'HTTP headers 必须是普通对象。');
  const entries = Object.entries(headers);
  if (entries.length > 64) fail('invalid_headers', 'HTTP headers 超过数量限制。');
  let bytes = 0;
  const seen = new Set();
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    if (!TOKEN.test(name) || seen.has(key)) fail('invalid_headers', 'HTTP header 名称无效或重复。');
    seen.add(key);
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.length > 16 || values.some(item => typeof item !== 'string' || CONTROL.test(item) || /[^\u0020-\u00ff]/u.test(item))) {
      fail('invalid_headers', 'HTTP header 值无效。');
    }
    bytes += Buffer.byteLength(name) + values.reduce((total, item) => total + Buffer.byteLength(item), 0);
    if (bytes > 16_384) fail('invalid_headers', 'HTTP headers 超过大小限制。');
  }
  return entries.map(([key, value]) => [key.toLowerCase(), value]);
}

export function filterWebRequestHeaders(headers = {}) {
  const filtered = {};
  for (const [name, value] of headerEntries(headers)) {
    if (!['content-type', 'accept', 'cookie'].includes(name)) continue;
    if (typeof value !== 'string') fail('invalid_headers', '请求 header 必须是字符串。');
    if (name !== 'cookie') filtered[name] = value;
    else {
      const cookies = value.split(';').map(item => item.trim()).filter(item => {
        const split = item.indexOf('=');
        return split > 0 && APP_COOKIE.test(item.slice(0, split)) && !/[\s,\\]/u.test(item.slice(split + 1));
      });
      if (cookies.length) filtered.cookie = cookies.join('; ');
    }
  }
  return filtered;
}

export function normalizeWebRequest({ method, path, headers = {}, body = '' } = {}) {
  if (typeof method !== 'string' || !METHODS.has(method)) fail('invalid_method', '不支持该 HTTP 方法。', 405);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\#\s\u0000-\u001f\u007f]/u.test(path)
    || Buffer.byteLength(path) > 4096) fail('invalid_path', '仅允许当前应用内的 HTTP 路径。');
  if (typeof body !== 'string') fail('invalid_body', '请求正文必须是 UTF-8 字符串。');
  if (Buffer.byteLength(body) > MAX_WEB_BODY) fail('body_limit', '请求正文不能超过 256 KiB。', 413);
  if (['GET', 'HEAD'].includes(method) && body) fail('invalid_body', 'GET 和 HEAD 不接受正文。');
  return { method, path, headers: filterWebRequestHeaders(headers), body };
}

export function filterWebResponseHeaders(headers = {}) {
  const filtered = {};
  for (const [name, value] of headerEntries(headers)) {
    if (!['content-type', 'cache-control', 'set-cookie', 'location'].includes(name)) continue;
    if (name === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : [value];
      for (const cookie of cookies) {
        const parts = cookie.split(';').map(item => item.trim());
        const split = parts[0].indexOf('=');
        if (split < 1 || !APP_COOKIE.test(parts[0].slice(0, split)) || !parts.some(item => /^httponly$/iu.test(item))
          || parts.some(item => /^domain\s*=/iu.test(item))) fail('invalid_response', '仅允许当前应用的 HttpOnly cookie。', 502);
      }
      filtered[name] = cookies;
    } else {
      if (typeof value !== 'string') fail('invalid_response', '响应 header 必须是字符串。', 502);
      if (name === 'location' && (!value.startsWith('/') || value.startsWith('//') || /[\\\s]/u.test(value))) {
        fail('invalid_response', '应用重定向只能使用当前来源内的相对路径。', 502);
      }
      filtered[name] = value;
    }
  }
  return filtered;
}

export function decodeWebResponse(response) {
  if (!plain(response) || Object.keys(response).some(key => !['status', 'headers', 'bodyBase64'].includes(key))
    || !Number.isInteger(response.status) || response.status < 200 || response.status > 599
    || typeof response.bodyBase64 !== 'string' || response.bodyBase64.length > Math.ceil(MAX_WEB_BODY / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(response.bodyBase64)) {
    fail('invalid_response', '受限应用响应格式无效。', 502);
  }
  const body = Buffer.from(response.bodyBase64, 'base64');
  if (body.length > MAX_WEB_BODY || body.toString('base64') !== response.bodyBase64) fail('invalid_response', '应用响应正文无效或超限。', 502);
  if ([204, 205, 304].includes(response.status) && body.length) fail('invalid_response', '该 HTTP 状态不能包含正文。', 502);
  return { status: response.status, headers: filterWebResponseHeaders(response.headers), body };
}

/** This decoder validates framing only; the runtime also validates phase and request identity. */
export class WebLineDecoder {
  constructor(onMessage, maxLineBytes = MAX_WEB_LINE) { this.pending = Buffer.alloc(0); this.onMessage = onMessage; this.maxLineBytes = maxLineBytes; }
  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const newline = this.pending.indexOf(10);
      if (newline < 0) {
        if (this.pending.length > this.maxLineBytes) fail('protocol_error', '应用协议行超限。', 502);
        return;
      }
      if (!newline || newline > this.maxLineBytes) fail('protocol_error', '应用协议行为空或超限。', 502);
      const bytes = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      let message;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { fail('protocol_error', '应用输出不是有效的逐行 JSON。', 502); }
      if (!plain(message)) fail('protocol_error', '应用协议消息必须是对象。', 502);
      this.onMessage(message);
    }
  }
  end() { if (this.pending.length) fail('protocol_error', '应用输出包含未完成的协议行。', 502); }
}
