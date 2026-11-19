export function repeatedCounterSteps(proposal) {
  const steps = proposal?.browser?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter(step => step?.op === 'createWithDelayedLoad' && steps.some(check => check?.op === 'count'
    && check.session === step.session && check.testId === step.countTestId && check.value === 0));
}
