const ASSERTIONS = new Set(['visible', 'text', 'value', 'count', 'createWithDelayedLoad']);

export function missingObservableBrowserRequirements(proposal, views = []) {
  const required = [...new Set(views.flatMap(view => view.requirementIds ?? []))];
  const browserSteps = Array.isArray(proposal?.browser?.steps) ? proposal.browser.steps : [];
  const covered = new Set(browserSteps.flatMap(step => ASSERTIONS.has(step?.op) && Array.isArray(step.requirementIds) ? step.requirementIds : []));
  return required.filter(id => !covered.has(id));
}
