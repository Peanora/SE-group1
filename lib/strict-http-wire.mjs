import { guardModelContent } from './model-content-guard.mjs';

export const strictHttpWire = 'deepseek-beta-slots-v1';
export const strictHttpTool = 'submit_verification_http_slots';

const names = count => Array.from({ length: count }, (_, index) => 'step' + String(index + 1).padStart(2, '0'));
const extras = supplement => supplement ? ['sessions'] : ['id', 'name', 'sessions'];

export function strictHttpEndpoint(settings) {
  if (settings.wireFormat === undefined) return null;
  const root = new URL(settings.baseUrl);
  if (settings.wireFormat !== strictHttpWire || root.origin !== 'https://api.deepseek.com'
    || !['', '/', '/beta', '/beta/'].includes(root.pathname) || root.username || root.password || root.search || root.hash
    || settings.model.trim() !== 'deepseek-v4-pro') throw new Error('当前配置无法使用测试清单的严格数据回包。');
  return new URL('/beta/chat/completions', root);
}

export function strictSlotNames(supplement, count) {
  if (!Number.isInteger(count) || count < 1 || count > 40) throw new Error('HTTP 槽位预算无效。');
  return [...extras(supplement), ...names(count)];
}

export function strictHttpToolRequest(supplement, count) {
  const fields = strictSlotNames(supplement, count);
  return {
    tools: [{ type: 'function', function: {
      name: strictHttpTool, strict: true,
      description: 'Submit verification scenario data. Each step field is empty or contains exactly one JSON step object.',
      parameters: { type: 'object', additionalProperties: false, required: fields,
        properties: Object.fromEntries(fields.map(name => [name, name === 'sessions' ? { type: 'array', items: { type: 'string' } } : { type: 'string' }])) },
    } }],
    tool_choice: { type: 'function', function: { name: strictHttpTool } },
  };
}

export function strictHttpResponse(envelope, rawEnvelope) {
  const choice = envelope.choices?.[0], calls = choice?.message?.tool_calls;
  const message = choice?.message?.content;
  const call = Array.isArray(calls) && calls.length === 1 ? calls[0] : null;
  const args = call?.function?.arguments;
  const valid = envelope.choices?.length === 1 && call?.type === 'function' && call.function?.name === strictHttpTool
    && typeof args === 'string' && (message == null || message === '') && !choice.message.function_call;
  // Failure receipts keep original argument strings private, including wrong or
  // repeated calls. They cannot be decoded as a successful slot response.
  const content = valid ? args : rawEnvelope;
  return { valid, content };
}

export function guardStrictHttpContent(content, apiKey, maxBytes) {
  const checked = guardModelContent(content, apiKey, maxBytes);
  if (checked.credentialResponse || !apiKey) return checked;
  const overflow = () => ({ credentialResponse: true, content: guardModelContent(apiKey, apiKey, maxBytes).content });
  // Both the provider argument object and each JSON step string are raw JSON.
  // Scan their decoded string tokens as well, before persisting either shape.
  const values = [{ value: content, layers: 3 }];
  let visited = 0;
  while (values.length) {
    const { value, layers } = values.pop();
    if (++visited > 40000) return overflow();
    if (typeof value === 'string') {
      if (guardModelContent(value, apiKey, maxBytes).credentialResponse) return overflow();
      if (layers > 0 && /^\s*[{[]/u.test(value)) {
        try { values.push({ value: JSON.parse(value), layers: layers - 1 }); } catch { /* The decoder rejects invalid JSON later. */ }
      }
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) values.push({ value: key, layers: 0 }, { value: item, layers });
    }
  }
  return checked;
}

function parseSlotJSON(content) {
  const value = JSON.parse(content), containers = [];
  // The built-in parser verifies grammar. This scan additionally rejects a
  // repeated property before JSON.parse can silently retain its last value.
  for (const token of content.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[\[\]{}]/gu)) {
    const text = token[0];
    if (text === '{' || text === '[') containers.push(text === '{' ? new Set() : null);
    else if (text === '}' || text === ']') containers.pop();
    else if (containers.at(-1) && /^\s*:/u.test(content.slice(token.index + text.length))) {
      const keys = containers.at(-1), key = JSON.parse(text);
      if (keys.has(key)) throw new Error('槽位 JSON 含重复字段。');
      keys.add(key);
    }
  }
  return value;
}
export function decodeStrictHttp(content, supplement, count) {
  const data = parseSlotJSON(content), fields = strictSlotNames(supplement, count);
  if (!data || Object.getPrototypeOf(data) !== Object.prototype || Object.keys(data).length !== fields.length
    || !fields.every(name => Object.hasOwn(data, name)) || !Array.isArray(data.sessions)
    || data.sessions.some(value => typeof value !== 'string')) throw new Error('HTTP 槽位回包形状无效。');
  const steps = [];
  for (const slot of names(count)) {
    const value = data[slot];
    if (typeof value !== 'string') throw new Error('HTTP 槽位必须是有界的 JSON 字符串。');
    if (!value) continue;
    const step = parseSlotJSON(value);
    if (!step || Object.getPrototypeOf(step) !== Object.prototype) throw new Error('每个 HTTP 槽位仅允许一个步骤。');
    steps.push(step);
  }
  if (supplement) return { sessions: data.sessions, steps };
  if (typeof data.id !== 'string' || typeof data.name !== 'string') throw new Error('HTTP 槽位须含清单编号和名称。');
  return { version: 1, id: data.id, name: data.name, sessions: data.sessions, steps };
}

export function verificationHttpFocus(requirements, missing, remaining) {
  const focus = missing ? requirements.filter(item => missing.includes(item.id))
    : requirements.slice(0, Math.ceil(requirements.length * .6));
  return { focus, targetSteps: Math.min(remaining ?? 32, Math.max(3, focus.length * 2 + 2)) };
}
