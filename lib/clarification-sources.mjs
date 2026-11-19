// Confirmation is derived from saved Q+A data, never from model-supplied approval.
const compact = value => value.trim().replace(/[\s。.!！?？,，;；]/gu, '');
const all = new Set(['都要','全部都要','全部需要','全部都需要','都需要','全部','全选','以上都要','全部包含','都包含']);
const yes = new Set(['是','是的','需要','要','支持','同意','确认','需要的']);
const unknown = new Set(['不知道','不确定','随便','都可以','看着办','是是','待确认']);

export function clarificationQuestion(question) {
  return question.replace(/^(?:请分别明确以下问题中的选项或事项（此前回答“[^”]*”还不能确定范围）：\s*)+/u, '').trim();
}

export function clarificationKey(question) {
  return clarificationQuestion(question).normalize('NFKC').toLowerCase().replace(/[\s。！？、，；：“”‘’.,!?;:]/gu, '');
}

export function distinctClarificationQuestions(questions) {
  const seen = new Set();
  return questions.filter(question => {
    const key = clarificationKey(question);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function needsConcreteAnswer(question, value) {
  const answer = compact(value);
  if (unknown.has(answer)) return true;
  if (!yes.has(answer) && !all.has(answer)) return false;
  const prompt = clarificationQuestion(question).replace(/（[^）]*）|\([^)]*\)/gu, '');
  return /还是|哪(?:种|项|些|个)|什么|请选择|[？?].+\S/u.test(prompt) && !(all.has(answer) && options(prompt).length);
}

export function submittedClarifications(run) {
  return (run.clarificationHistory ?? []).findLast(round => round.kind !== 'inherited' && round.kind !== 'spec_repair'
    && round.answers?.some(item => typeof item.question === 'string' && typeof item.answer === 'string' && item.answer.trim())) ?? null;
}

export function clarificationFollowUps(run) {
  const latest = new Map();
  for (const item of submittedClarifications(run)?.answers ?? []) {
    if (typeof item.question !== 'string' || typeof item.answer !== 'string' || !item.answer.trim()) continue;
    latest.set(clarificationKey(item.question), { question: clarificationQuestion(item.question), answer: item.answer });
  }
  return new Map([...latest].filter(([, item]) => needsConcreteAnswer(item.question, item.answer)));
}

function options(question) {
  const prompt = clarificationQuestion(question);
  const marked = prompt.match(/(?:是否包括|是否包含|核心功能|功能)[：:]\s*([^]*)/u);
  const enumerated = !marked && prompt.match(/^([^？?]+)[，,：:]\s*(?:首版|第一版|V1)(?:中)?(?:分别)?(?:需要|包含|支持|实现|做)哪些[？?。]?$/iu);
  if (!marked && (!enumerated || /还是|或者|二选一|只能|仅限/u.test(enumerated[1]))) return [];
  const text = marked ? marked[1].split(/[？?]/u)[0] : enumerated[1];
  let depth = 0, part = ''; const result = [];
  for (const char of text) {
    if ('（([【'.includes(char)) depth++;
    if ('）)]】'.includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && '、，,；;'.includes(char)) { if (part.trim()) result.push(part.trim()); part = ''; }
    else part += char;
  }
  if (part.trim()) result.push(part.trim());
  const items = result.filter(value => value && !/^(?:请|并请)/u.test(value));
  return marked || items.length > 1 ? items : [];
}
function positiveSubject(question) {
  // A yes to alternatives or multiple questions does not select a proposition.
  question = clarificationQuestion(question);
  if ((question.match(/[？?]/gu) || []).length > 1) return null;
  const outer = question.replace(/（[^）]*）|\([^)]*\)/gu, '');
  if (/还是|或者|或仅|或是|或/u.test(outer)) return null;
  const match = question.trim().match(/^是否(?:需要|支持|包含|包括|允许)([^]*?)[？?。]?$/u);
  return match?.[1]?.trim() || null;
}
export function clarificationSources(run) {
  return (run.clarificationHistory || []).flatMap((round, roundIndex) => (round.answers || []).flatMap((q, index) => {
    if (typeof q.question !== 'string' || typeof q.answer !== 'string' || !q.answer.trim()) return [];
    const answer = compact(q.answer), record = { id: `C-${roundIndex + 1}-${index + 1}`, questionId: q.id, round: roundIndex + 1, question: q.question, answer: q.answer, decision: 'answered', quotes: [] };
    if (/^(?:否|不需要|不要|不支持|不包含|不包括|不采纳|不同意|首版不)/u.test(answer)) record.decision = 'rejected';
    else if (all.has(answer)) {
      record.quotes = options(q.question);
      if (!record.quotes.length) { const subject = positiveSubject(q.question); if (subject) record.quotes = [subject]; }
      record.decision = record.quotes.length ? 'confirmed' : needsConcreteAnswer(q.question, q.answer) ? 'unresolved' : 'answered';
    } else if (yes.has(answer)) {
      const subject = positiveSubject(q.question); if (subject) record.quotes = [subject];
      record.decision = subject ? 'confirmed' : needsConcreteAnswer(q.question, q.answer) ? 'unresolved' : 'answered';
    } else if (unknown.has(answer)) record.decision = 'unresolved';
    return [record];
  }));
}
export function confirmedSourceText(run) {
  return latestClarificationSources(run).filter(record => record.decision === 'confirmed')
    .map(record => JSON.stringify({ id: record.id, questionId: record.questionId, question: record.question, answer: record.answer, confirmedQuotes: record.quotes }));
}

export function latestClarificationSources(run) {
  return [...new Map(clarificationSources(run).map(record => [clarificationKey(record.question), record])).values()];
}
