import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MAX_BYTES = 512 * 1024;
export const modelContentGuardPolicy = Object.freeze({ version: 'json-escape-credential-v2',
  hash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), maxBytes: MAX_BYTES });
const escapes = Object.freeze({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' });

/** Checks literal text and one layer of JSON string escapes. Never executes data. */
export function guardModelContent(content, apiKey, maxBytes = MAX_BYTES) {
  if (typeof content !== 'string' || typeof apiKey !== 'string' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
    throw Object.assign(new TypeError('模型正文凭据检查输入无效。'), { code: 'invalid_content_guard' });
  }
  if (content.length > maxBytes || Buffer.byteLength(content) > maxBytes) {
    throw Object.assign(new Error('模型正文超过凭据检查的有界预算。'), { code: 'content_inspection_limit' });
  }
  const redacted = () => ({ credentialResponse: true,
    // Even unusual short credentials must not occur inside the placeholder.
    content: maxBytes >= 10 && !'[REDACTED]'.includes(apiKey) ? '[REDACTED]' : '' });
  if (!apiKey) return { credentialResponse: false, content };
  if (content.includes(apiKey)) return redacted();
  // Decode one layer solely for detection, regardless of quote alignment.
  // Each input unit is consumed once, with at most four lookahead units;
  // output never grows or gets rescanned. Stray quotes cannot hide a token.
  const parts = []; let literalStart = 0;
  for (let offset = 0; offset < content.length; offset++) {
    if (content.charCodeAt(offset) !== 92) continue;
    const escape = content[offset + 1]; let value, length;
    if (escape === 'u' && offset + 5 < content.length && /^[0-9a-f]{4}$/iu.test(content.slice(offset + 2, offset + 6))) {
      value = String.fromCharCode(Number.parseInt(content.slice(offset + 2, offset + 6), 16)); length = 6;
    } else if (Object.hasOwn(escapes, escape)) { value = escapes[escape]; length = 2; }
    else continue; // Unknown or incomplete escapes remain literal data.
    if (literalStart < offset) parts.push(content.slice(literalStart, offset));
    parts.push(value); offset += length - 1; literalStart = offset + 1;
  }
  if (literalStart < content.length) parts.push(content.slice(literalStart));
  if (parts.join('').includes(apiKey)) return redacted();
  return { credentialResponse: false, content };
}
