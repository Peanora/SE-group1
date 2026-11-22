import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticUsage } from '../lib/automatic-usage.mjs';

const complete = (inputTokens, outputTokens, costEstimate) => ({ transport: { dispatched: true, responseComplete: true },
  receiptState: 'saved', receipt: { sha256: 'digest' }, usage: { inputTokens, outputTokens }, costEstimate });

test('automatic usage preserves partial token evidence and excludes manual definitions and undispatched attempts', () => {
  const known = complete(7, 11, { currency: 'CNY', amount: 0.00004 });
  const pending = { transport: { dispatched: null }, receiptState: 'not_received', usage: { inputTokens: 0, outputTokens: 0 } };
  const actual = automaticUsage({ automaticDelivery: { pendingDispatch: { kind: 'development' } }, specificationCalls: 3,
    specificationHistory: [known, pending, { transport: { dispatched: false } }],
    engineeringHistory: [complete(0, null, null)] }, [
    { ...known, origin: 'model', dispatched: true, status: 'failed' }, { origin: 'manual', dispatched: false, status: 'approved' },
  ], []);
  assert.deepEqual(actual.specification, { totalModelCalls: null, confirmedCalls: 1, uncertainRequests: 1,
    usage: { inputTokens: null, outputTokens: null }, observedUsage: { inputTokens: 7, outputTokens: 11 },
    costEstimate: { known: false, amount: null, currency: null, amounts: [{ currency: 'CNY', amount: 0.00004 }] } });
  assert.equal(actual.engineering.totalModelCalls, 1);
  assert.deepEqual(actual.engineering.usage, { inputTokens: 0, outputTokens: null });
  assert.equal(actual.verification.totalModelCalls, 1);
  assert.equal(actual.verification.costEstimate.amount, 0.00004);
  assert.equal(actual.development.totalModelCalls, null);
  assert.equal(actual.development.uncertainRequests, null);
});

test('several development attempts retain individual frozen prices without sharing rates across models or currencies', () => {
  const row = (id, currency, outputPerMillion) => ({ id, totalModelCalls: 1, modelPrices: { coding: { currency, model: 'sample', inputPerMillion: 1, outputPerMillion } },
    modelCalls: [{ kind: 'model', role: 'coding', model: 'sample', receiptConfirmed: true, receiptHash: 'digest', dispatched: true, usage: { inputTokens: 1, outputTokens: 2 } },
      { kind: 'model', role: 'review', dispatched: false, usage: { inputTokens: 0, outputTokens: 0 } }] });
  const { development } = automaticUsage({ automaticDelivery: { executionId: 'second' } }, [], [row('first', 'CNY', 2), row('second', 'USD', 3)]);
  assert.equal(development.totalModelCalls, 2);
  assert.deepEqual(development.usage, { inputTokens: 2, outputTokens: 4 });
  assert.deepEqual(development.costEstimate, { known: false, amount: null, currency: null, amounts: [{ currency: 'CNY', amount: 0.000005 }, { currency: 'USD', amount: 0.000007 }] });
  const legacy = row('old', 'USD', 3); delete legacy.modelPrices;
  assert.equal(automaticUsage({}, [], [legacy]).development.costEstimate.amount, null);
  assert.equal(automaticUsage({}, undefined, undefined).verification.totalModelCalls, null);
});
