import { createHash } from 'node:crypto';

/** Apply a validated opinion to the issue IDs from the preceding candidate. */
export function reconcilePlannedReviewIssues({ result, previousIssues, commit }) {
  const resolutions = new Map(result.resolutions.map(item => [item.id, item]));
  const checked = previousIssues.map(issue => {
    const resolution = resolutions.get(issue.id);
    if (!resolution) return { ...issue, status: 'open' };
    return { ...issue, status: resolution.status, checkedCommit: commit, resolution: resolution.reason };
  });
  const discovered = result.issues.map(issue => {
    const key = createHash('sha256').update(JSON.stringify({ ...issue, commit })).digest('hex').slice(0, 20);
    return { ...issue, id: `ISSUE-${key}`, status: 'open', originCommit: commit };
  });
  const issues = [...checked, ...discovered];
  return { issues, openBlockingIssues: issues.filter(issue => issue.severity === 'blocking' && issue.status !== 'resolved').length };
}
