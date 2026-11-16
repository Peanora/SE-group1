// Confirmation is derived from saved Q+A data, never from model-supplied approval.
const compact = value => value.trim().replace(/[\s。.!！?？,，;；]/gu, '');
const all = new Set(['都要','全部都要','全部需要','全部都需要','都需要','全部','全选','以上都要','全部包含','都包含']);
const yes = new Set(['是','是的','需要','要','支持','同意','确认','需要的']);
const unknown = new Set(['不知道','不确定','随便','都可以','看着办','是是','待确认']);
function options(question) {
  const match = question.match(/(?:是否包括|是否包含|核心功能|功能)[：:]\s*([^]*)/u);
  if (!match) return [];
  const text = match[1].split(/[？?]/u)[0]; let depth = 0, part = ''; const result = [];
  for (const char of text) {
    if ('（([【'.includes(char)) depth++;
    if ('）)]】'.includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && '、，,；;'.includes(char)) { if (part.trim()) result.push(part.trim()); part = ''; }
    else part += char;
  }
  if (part.trim()) result.push(part.trim());
  return result.filter(value => value && !/^(?:请|并请)/u.test(value));
}
function positiveSubject(question) {
  // A yes to alternatives or multiple questions does not select a proposition.
  if ((question.match(/[？?]/gu) || []).length > 1) return null;
  const outer = question.replace(/（[^）]*）|\([^)]*\)/gu, '');
  if (/还是|或者|或仅|或是|或/u.test(outer)) return null;
  const match = question.trim().match(/^是否(?:需要|支持|包含|包括|允许)([^]*?)[？?。]?$/u);
  return match?.[1]?.trim() || null;
}
export function clarificationSources(run) {
  return (run.clarificationHistory || []).flatMap((round, roundIndex) => (round.answers || []).flatMap((q, index) => {
    if (typeof q.question !== 'string' || typeof q.answer !== 'string') return [];
    const answer = compact(q.answer), record = { id: `C-${roundIndex + 1}-${index + 1}`, questionId: q.id, round: roundIndex + 1, question: q.question, answer: q.answer, decision: 'answered', quotes: [] };
    if (/^(?:否|不需要|不要|不支持|不包含|不包括|不采纳|不同意|首版不)/u.test(answer)) record.decision = 'rejected';
    else if (all.has(answer)) {
      record.quotes = options(q.question);
      if (!record.quotes.length) { const subject = positiveSubject(q.question); if (subject) record.quotes = [subject]; }
      record.decision = record.quotes.length ? 'confirmed' : 'unresolved';
    } else if (yes.has(answer)) {
      const subject = positiveSubject(q.question); if (subject) record.quotes = [subject];
      record.decision = subject ? 'confirmed' : 'unresolved';
    } else if (unknown.has(answer)) record.decision = 'unresolved';
    return [record];
  }));
}
export function confirmedSourceText(run) {
  return clarificationSources(run).filter(record => record.decision === 'confirmed')
    .map(record => JSON.stringify({ id: record.id, questionId: record.questionId, question: record.question, answer: record.answer, confirmedQuotes: record.quotes }));
}
