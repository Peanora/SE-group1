// Runs inside MXC. The VM separates JavaScript observations, not OS permissions.
'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const stringify = JSON.stringify;
const descriptors = Object.getOwnPropertyDescriptors;
const ownKeys = Reflect.ownKeys;
const array = Array.isArray;
const write = process.stdout.write.bind(process.stdout);

// Copy data without invoking candidate getters, toJSON, iterators or thenables.
function plain(value, seen = new Set(), depth = 0) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value) || depth > 12) throw new Error('INVALID_OBSERVATION');
  seen.add(value);
  try {
    const desc = descriptors(value), keys = ownKeys(desc);
    if (keys.length > 1000 || keys.some(key => typeof key !== 'string')) throw new Error('INVALID_OBSERVATION');
    const result = array(value) ? [] : Object.create(null);
    for (const key of keys) {
      if (array(value) && key === 'length') continue;
      if (array(value) && !/^(?:0|[1-9][0-9]*)$/.test(key)) throw new Error('INVALID_OBSERVATION');
      const item = desc[key];
      if (!Object.hasOwn(item, 'value')) throw new Error('INVALID_OBSERVATION');
      Object.defineProperty(result, key, { value: plain(item.value, seen, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return result;
  } finally { seen.delete(value); }
}
function errorMessage(error) {
  try {
    const message = descriptors(error).message;
    return message && Object.hasOwn(message, 'value') && typeof message.value === 'string' ? message.value : 'INVALID_ERROR';
  } catch { return 'INVALID_ERROR'; }
}

(async () => {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const inputs = JSON.parse(text);
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  // No host objects, callbacks, process, require, console or timers enter this realm.
  vm.runInContext(`globalThis.console = undefined;
    Object.defineProperty(Error, 'prepareStackTrace', {value: undefined, writable: false, configurable: false});`, context);
  const parse = vm.runInContext('JSON.parse.bind(JSON)', context);
  const realmError = vm.runInContext('message => new Error(message)', context);
  const module = new vm.SourceTextModule(fs.readFileSync('src/borrow.mjs', 'utf8'), {
    context,
    importModuleDynamically() { throw realmError('IMPORT_NOT_ALLOWED'); },
  });
  if (module.dependencySpecifiers.length) throw new Error('IMPORT_NOT_ALLOWED');
  await module.link(() => { throw realmError('IMPORT_NOT_ALLOWED'); });
  await module.evaluate({ timeout: 1000 });
  const borrow = module.namespace.borrowBook;
  if (typeof borrow !== 'function') throw new Error('INVALID_EXPORT');
  const results = [];
  for (const input of inputs) {
    const item = parse(stringify(input));
    const state = item.sequence ? item.sequence[0] : item.state;
    const before = stringify(plain(state));
    let observation;
    try {
      if (item.sequence) {
        const first = borrow(state, item.sequence[1]);
        let secondError = null;
        try { borrow(first, item.sequence[2]); } catch (error) { secondError = errorMessage(error); }
        observation = { value: { first: plain(first), secondError } };
      } else observation = { value: plain(borrow(state, item.userId)) };
    } catch (error) { observation = { error: errorMessage(error) }; }
    let unchanged = false;
    try { unchanged = stringify(plain(state)) === before; } catch { /* Malformed state is a failed immutability check. */ }
    results.push({ ...observation, unchanged });
  }
  write(stringify(results));
})().catch(() => { process.stderr.write('候选模块无法加载或执行'); process.exitCode = 1; });
