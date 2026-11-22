import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePlannedCost, normalizeModelPricing } from '../lib/planned-model-cost.mjs';

const coding = { model: 'code', currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8 };
const review = { model: 'review', currency: 'CNY', inputPerMillion: 1, outputPerMillion: 12 };
const call = (role, model, inputTokens, outputTokens, patch = {}) => ({ role, model, kind: 'model', dispatched: true, receiptConfirmed: true,
  usage: { inputTokens, outputTokens }, ...patch });

test('价格按对应角色、模型及百万 token 计价，保留曾经发送的失败调用', () => {
  const recorded = { totalModelCalls: 3, modelCalls: [call('coding', 'code', 1_000_000, 100_000), call('review', 'review', 2_000_000, 10_000),
    call('coding', 'code', 50_000, 50_000, { finishReason: 'length' }), call('review', 'review', null, null, { dispatched: false }),
    call('coding', 'code', 1_000_000, 1_000_000, { kind: 'trusted_fixture' })] };
  assert.deepEqual(estimatePlannedCost(recorded, { coding, review }, true), { known: true, amount: 5.42, currency: 'CNY', reason: null,
    amounts: [{ currency: 'CNY', amount: 5.42 }], pricedCalls: 3, unpricedCalls: 0 });
  assert.equal(estimatePlannedCost(recorded, undefined, true).amount, null);
  assert.equal(estimatePlannedCost(recorded, { coding, review }, false).known, false);
  assert.deepEqual(estimatePlannedCost(recorded, { coding, review: { ...review, currency: 'USD' } }, true).amounts,
    [{ currency: 'CNY', amount: 3.3 }, { currency: 'USD', amount: 2.12 }]);
  assert.equal(estimatePlannedCost(recorded, { coding, review: { ...review, currency: 'USD' } }, true).amount, null);
});

test('缺回执、缺一项 token、模型别名变化或调用记录不完整时总金额未知', () => {
  const recorded = { totalModelCalls: 4, modelCalls: [call('coding', 'code', 10, 20), call('review', 'different', 10, 20),
    call('review', 'review', 10, null), call('review', 'review', 10, 20, { receiptConfirmed: false })] };
  const estimate = estimatePlannedCost(recorded, { coding, review }, true);
  assert.equal(estimate.known, false); assert.equal(estimate.amount, null);
  assert.equal(estimate.pricedCalls, 1); assert.equal(estimate.unpricedCalls, 3);
  assert.deepEqual(estimate.amounts, [{ currency: 'CNY', amount: 0.00018 }]);
  assert.equal(estimatePlannedCost({ ...recorded, totalModelCalls: 5 }, { coding, review }, true).reason, '调用记录不完整。');
  const zero = estimatePlannedCost({ totalModelCalls: 0, modelCalls: [] }, { coding, review }, true);
  assert.equal(zero.known, true); assert.equal(zero.amount, 0);
});

test('模型单价接受明确零费率，拒绝非法货币、数值及未授权字段', () => {
  assert.deepEqual(normalizeModelPricing({ currency: 'USD', inputPerMillion: 0, outputPerMillion: 0 }), { currency: 'USD', inputPerMillion: 0, outputPerMillion: 0 });
  for (const invalid of [true, [], { currency: 'BAD', inputPerMillion: 1, outputPerMillion: 2 }, { currency: 'USD', inputPerMillion: '1', outputPerMillion: 2 },
    { currency: 'USD', inputPerMillion: -1, outputPerMillion: 2 }, { currency: 'USD', inputPerMillion: 1, outputPerMillion: Number.NaN },
    { currency: 'USD', inputPerMillion: 1 }, { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, unit: 'thousand' }]) {
    assert.throws(() => normalizeModelPricing(invalid), TypeError);
  }
});
