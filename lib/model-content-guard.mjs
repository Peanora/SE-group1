import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MAX_BYTES = 512 * 1024;
export const modelContentGuardPolicy = Object.freeze({ version: 'json-string-credential-v1',
  hash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), maxBytes: MAX_BYTES });

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
  // Every code unit belongs to at most one scan/token. The input byte cap
  // bounds scanning and allocations; nesting depth never consumes JS stack.
  for (let offset = 0; offset < content.length;) {
    if (content.charCodeAt(offset) !== 34) { offset++; continue; }
    const start = offset++; let complete = false;
    while (offset < content.length) {
      const character = content.charCodeAt(offset++);
      if (character === 92) { if (offset < content.length) offset++; }
      else if (character === 34) { complete = true; break; }
    }
    if (!complete) break;
    try {
      const value = JSON.parse(content.slice(start, offset));
      if (typeof value === 'string' && value.includes(apiKey)) return redacted();
    } catch { /* Invalid JSON strings stay data; never expose parser text. */ }
  }
  return { credentialResponse: false, content };
}
