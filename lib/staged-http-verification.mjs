import { inspectVerificationProposal } from './verification-contract.mjs';

export const isHttpGeneration = stage => stage === 'http' || stage === 'http-supplement';

function requests(step) {
  if (step?.type === 'request') return [step.request];
  if (step?.type === 'concurrent' && Array.isArray(step.requests)) return step.requests;
  return [];
}

function normalizeAssertionIdentifiers(proposal) {
  const assertions = proposal.steps.flatMap(step => requests(step).flatMap(request => Array.isArray(request?.assertions) ? request.assertions : []));
  const original = new Set(assertions.map(assertion => assertion?.id)), seen = new Set();
  let number = 0;
  for (const assertion of assertions) {
    if (typeof assertion?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(assertion.id) || /^(?:SYS_|CAP_|GROUP_|RESTART_)/u.test(assertion.id)) continue;
    if (seen.has(assertion.id)) {
      let identifier;
      do identifier = 'staged-assertion-' + ++number;
      while (original.has(identifier));
      assertion.id = identifier;
    }
    seen.add(assertion.id);
  }
}

function bodyVariables(value) {
  if (Array.isArray(value)) return value.flatMap(bodyVariables);
  if (!value || typeof value !== 'object') return [];
  return Object.hasOwn(value, '$var') ? [value.$var] : Object.values(value).flatMap(bodyVariables);
}

// The execution order is already explicit. Complete a missing edge only when
// its referenced value has a preceding producer, then let the DSL validate the
// entire graph, including any ambiguous captures and invalid explicit edges.
function completeCaptureDependencies(steps, existingCount) {
  const captures = new Map(), ancestors = new Map();
  for (const [index, step] of steps.entries()) {
    if (!Array.isArray(step?.dependsOn)) continue;
    const dependencies = new Set(step.dependsOn.flatMap(dependency => [dependency, ...(ancestors.get(dependency) ?? [])]));
    const items = requests(step);
    if (index >= existingCount) for (const request of items) {
      if (!request || typeof request.path !== 'string' || !Array.isArray(request.assertions)) continue;
      const references = [...request.path.matchAll(/\$\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu)].map(match => match[1]);
      references.push(...bodyVariables(request.body), ...request.assertions.flatMap(assertion => bodyVariables(assertion?.value)));
      for (const name of references) {
        const producer = captures.get(name);
        if (!producer || dependencies.has(producer)) continue;
        step.dependsOn.push(producer);
        dependencies.add(producer);
        for (const dependency of ancestors.get(producer) ?? []) dependencies.add(dependency);
      }
    }
    ancestors.set(step.id, dependencies);
    if (step.type === 'request' && Array.isArray(step.request?.captures)) {
      for (const capture of step.request.captures) if (typeof capture?.name === 'string') captures.set(capture.name, step.id);
    }
  }
}

/** Preserve requests, assertion expectations and order while completing declared capture use. */
export function inspectStagedHttp(raw, { requirements, binding, previous }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.steps)
    || (previous ? Object.keys(raw).length !== 2 || !Array.isArray(raw.sessions) || raw.sessions.some(value => typeof value !== 'string')
      || new Set(raw.sessions).size !== raw.sessions.length || raw.steps.length === 0 : Object.hasOwn(raw, 'browser') || Object.hasOwn(raw, 'taskScopes'))) {
    throw new Error('受控 HTTP 阶段形状无效。');
  }
  const proposal = previous ? structuredClone({
    ...previous, sessions: [...new Set([...previous.sessions, ...raw.sessions])], steps: [...previous.steps, ...raw.steps],
  }) : structuredClone(raw);
  const known = new Set(requirements), exercised = new Set(), declared = new Set();
  for (const step of proposal.steps) {
    for (const id of Array.isArray(step?.requirementIds) ? step.requirementIds : []) {
      if (!known.has(id)) throw new Error('覆盖了未知需求。');
      declared.add(id);
      if (step.type !== 'restart') exercised.add(id);
    }
  }
  normalizeAssertionIdentifiers(proposal);
  completeCaptureDependencies(proposal.steps, previous?.steps.length ?? 0);
  const scope = requirements.filter(id => declared.has(id));
  const inspected = inspectVerificationProposal({ proposal, requirements: scope, binding });
  if (!exercised.size) throw new Error('HTTP 草案没有覆盖实际请求。');
  const missing = requirements.filter(id => !exercised.has(id));
  if (previous) {
    const before = new Set(previous.steps.filter(step => step.type !== 'restart').flatMap(step => step.requirementIds));
    if (exercised.size <= before.size) throw new Error('补充没有增加任何缺项的实际请求断言。');
  }
  return { proposal, inspected, missing };
}
