import { estimateModelCall, normalizeModelPricing } from './planned-model-cost.mjs';

const validTokens = value => Number.isSafeInteger(value) && value >= 0;
const observed = value => validTokens(value) ? value : null;

function summarize(requests, incomplete) {
  const calls = requests.filter(item => item.dispatched === true);
  const uncertain = requests.filter(item => item.dispatched === null).length;
  const totalModelCalls = incomplete || uncertain ? null : calls.length;
  const usage = {}, observedUsage = {}, amountsByCurrency = new Map();
  for (const key of ['inputTokens', 'outputTokens']) {
    const numbers = calls.map(item => observed(item.usage?.[key])).filter(value => value !== null);
    const sum = numbers.reduce((total, value) => total + value, 0);
    observedUsage[key] = numbers.length ? observed(sum) : null;
    usage[key] = totalModelCalls !== null && numbers.length === calls.length ? observed(sum) : null;
  }
  let pricedCalls = 0;
  for (const call of calls) {
    const estimate = call.costEstimate;
    if (!estimate || typeof estimate.currency !== 'string' || !/^[A-Z]{3}$/u.test(estimate.currency)
      || !Number.isFinite(estimate.amount) || estimate.amount < 0) continue;
    const amount = (amountsByCurrency.get(estimate.currency) ?? 0) + estimate.amount;
    if (!Number.isFinite(amount)) { incomplete = true; continue; }
    amountsByCurrency.set(estimate.currency, amount); pricedCalls++;
  }
  const amounts = [...amountsByCurrency].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: Number(amount.toPrecision(12)) }));
  const known = !incomplete && totalModelCalls !== null && pricedCalls === totalModelCalls && amounts.length === 1;
  return { totalModelCalls, confirmedCalls: calls.length, uncertainRequests: incomplete ? null : uncertain, usage, observedUsage,
    costEstimate: { known, amount: known ? amounts[0].amount : null, currency: known ? amounts[0].currency : null, amounts } };
}

function planningCall(row) {
  const receipt = row.receiptState === 'saved' && !!row.receipt?.sha256;
  const transport = row.coordination?.resolved ? row.coordination.transport : row.transport;
  return { dispatched: receipt || transport?.dispatched === true ? true : transport?.dispatched === false ? false : null,
    usage: receipt || transport?.responseComplete === true ? row.usage : null, costEstimate: receipt ? row.costEstimate : null };
}

function verificationCall(row) {
  const receipt = row.receiptState === 'saved' && !!row.receipt?.sha256;
  const unsettled = ['generating', 'cancel_requested', 'reconciliation_required'].includes(row.status);
  return { dispatched: receipt ? true : unsettled ? null : row.dispatched,
    usage: receipt ? row.usage : null, costEstimate: receipt ? row.costEstimate : null };
}

function developmentCall(call, prices) {
  const receipt = call.receiptConfirmed === true && !!call.receiptHash;
  const price = Object.hasOwn(prices ?? {}, call.role) ? prices[call.role] : null;
  let estimate = null;
  try { if (receipt && price && normalizeModelPricing({ currency: price.currency, inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion })) estimate = estimateModelCall(call, price); }
  catch { /* Invalid persisted pricing cannot authorize an estimate. */ }
  const dispatched = receipt || call.requestState === 'completed' && call.dispatched === true ? true : call.dispatched === false ? false : null;
  return { dispatched, usage: receipt ? call.usage : null, costEstimate: estimate };
}

export function automaticUsage(run, proposals, executions) {
  const state = run.automaticDelivery ?? {};
  const spec = run.specificationHistory ?? [], engineering = run.engineeringHistory ?? [];
  const proposed = proposals?.filter(item => item.origin === 'model') ?? [];
  const developerCalls = (executions ?? []).flatMap(row => (row.modelCalls ?? []).filter(call => call.kind === 'model').map(call => developmentCall(call, row.modelPrices)));
  const incompleteDevelopment = !executions || state.pendingDispatch?.kind === 'development' || (state.executionId && !executions.some(row => row.id === state.executionId))
    || executions.some(row => row.status === 'reconciliation_required' || row.active && !(row.modelCalls?.length)
      || Number.isSafeInteger(row.totalModelCalls) && row.totalModelCalls > (row.modelCalls ?? []).filter(call => call.kind === 'model' && call.dispatched !== false).length);
  return {
    specification: summarize([...spec, ...(run.planningIssueHistory ?? [])].map(planningCall), (run.specificationCalls ?? 0) > spec.length),
    engineering: summarize(engineering.map(planningCall), (run.engineeringCalls ?? 0) > engineering.length),
    verification: summarize(proposed.map(verificationCall), !proposals || state.pendingDispatch?.kind === 'verification'),
    development: summarize(developerCalls, incompleteDevelopment),
  };
}
