import test from 'node:test';
import assert from 'node:assert/strict';
import { copyBrowserScenarioData } from '../lib/browser-scenario-contract.mjs';

test('large host execution evidence has an explicit bounded node budget without broadening default public proposals', () => {
  const evidence = Array.from({ length: 100 }, () => Array.from({ length: 400 }, (_, index) => ({ id: `check-${index}`, passed: true })));
  assert.throws(() => copyBrowserScenarioData(evidence, 32 * 1024 * 1024));
  const actual = copyBrowserScenarioData(evidence, 32 * 1024 * 1024, { maxNodes: 250000 }); assert.deepEqual(actual, evidence); assert.notEqual(actual, evidence);
  assert.throws(() => copyBrowserScenarioData(evidence, 100, { maxNodes: 250000 }), 'larger host node budget never bypasses byte budget');
  const excessive = Array.from({ length: 500 }, () => Array.from({ length: 600 }, () => true));
  assert.throws(() => copyBrowserScenarioData(excessive, 32 * 1024 * 1024, { maxNodes: 250000 }));
});
test('trusted limit and host records still refuse getters, symbols, prototypes, sparse arrays and serialization hooks', () => {
  let calls = 0; const limits = {}; Object.defineProperty(limits, 'maxNodes', { enumerable: true, get() { calls++; return 250000; } });
  assert.throws(() => copyBrowserScenarioData({}, 100, limits)); assert.equal(calls, 0);
  for (const value of [0, null, '250000', 24999, 250001, Infinity]) assert.throws(() => copyBrowserScenarioData({}, 100, { maxNodes: value }));
  assert.throws(() => copyBrowserScenarioData({}, 100, { maxNodes: 250000, arbitrary: true }));
  const object = {}; Object.defineProperty(object, 'value', { enumerable: true, get() { calls++; return 1; } });
  for (const value of [object, { toJSON() { calls++; return {}; } }, Object.assign({}, { [Symbol('secret')]: 1 }), new Array(2), Object.create({ inherited: true })]) assert.throws(() => copyBrowserScenarioData(value, 1024, { maxNodes: 250000 }));
  assert.equal(calls, 0);
});
