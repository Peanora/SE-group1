const currencies = new Set(Intl.supportedValuesOf('currency'));
const tokenFields = ['inputTokens', 'outputTokens'];
const validTokens = value => Number.isSafeInteger(value) && value >= 0;
const validRate = value => typeof value === 'number' && value >= 0 && value <= 1_000_000;
const formatAmount = value => Number(value.toPrecision(12));

export const unknownPlannedCost = Object.freeze({ known: false, amount: null, currency: null,
  reason: '未配置模型单价；费用估算未知，实际调用和token用量单独记录。' });

export function normalizeModelPricing(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Object.getOwnPropertySymbols(raw).length) throw new TypeError('模型单价格式无效。');
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(fields).length !== 3 || !['currency', 'inputPerMillion', 'outputPerMillion'].every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], 'value'))) {
    throw new TypeError('模型单价需要货币代码、每百万输入及输出 token 的价格。');
  }
  const { currency, inputPerMillion, outputPerMillion } = raw;
  if (!currencies.has(currency) || !validRate(inputPerMillion) || !validRate(outputPerMillion)) {
    throw new TypeError('请使用有效的三位货币代码，输入和输出单价均须为 0 至 1000000。');
  }
  return Object.freeze({ currency, inputPerMillion, outputPerMillion });
}

export function configuredModelPrice(config) {
  const pricing = normalizeModelPricing(config.pricing);
  return pricing && typeof config.model === 'string' && config.model.trim() ? { model: config.model.trim(), ...pricing } : null;
}

export function estimateModelCall({ model, usage }, price) {
  if (!price || model !== price.model || !tokenFields.every(key => validTokens(usage?.[key]))) return null;
  return { currency: price.currency, amount: (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1_000_000 };
}

export function estimatePlannedCost(record, prices, settled) {
  if (!prices) return unknownPlannedCost;
  const calls = (Array.isArray(record?.modelCalls) ? record.modelCalls : []).filter(call => call.kind === 'model' && call.dispatched !== false);
  const totals = new Map();
  let pricedCalls = 0;
  for (const call of calls) {
    const price = Object.hasOwn(prices, call.role) ? prices[call.role] : null;
    const estimate = call.receiptConfirmed === true ? estimateModelCall(call, price) : null;
    if (!estimate) continue;
    totals.set(estimate.currency, (totals.get(estimate.currency) ?? 0) + estimate.amount);
    pricedCalls++;
  }
  if (settled && record?.totalModelCalls === 0 && calls.length === 0) {
    for (const price of Object.values(prices)) totals.set(price.currency, 0);
  }
  const amounts = [...totals].sort(([left], [right]) => left.localeCompare(right)).map(([currency, amount]) => ({ currency, amount: formatAmount(amount) }));
  const reason = !settled ? '执行或用量尚未结算。'
    : record?.totalModelCalls !== calls.length ? '调用记录不完整。'
    : calls.length !== pricedCalls ? '部分调用缺少完整 token 回执，或没有匹配本次冻结的模型单价。'
    : amounts.length !== 1 ? '各模型使用不同计价货币，按币种分别估算。' : null;
  return { known: !reason, amount: reason ? null : amounts[0].amount, currency: reason ? null : amounts[0].currency,
    reason, amounts, pricedCalls, unpricedCalls: calls.length - pricedCalls };
}
