// Pure public acceptance data. No application, model responses, I/O or authority.
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const variable = name => ({ $var: name });
export const equal = (path, value) => ({ op: 'jsonEquals', path, value });
export const length = (path, value) => ({ op: 'jsonLength', path, value });
export const exists = path => ({ op: 'jsonExists', path });
export function buildKit({ id, name, keys, requirements, coverage, sessions }) {
  if (!Array.isArray(requirements) || !requirements.length) throw new Error('Pass actual confirmed spec.requirements; no fixture specification is supplied.');
  const ids = requirements.map(item => item.id);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string') || !coverage || Object.keys(coverage).sort().join() !== [...keys].sort().join()) throw new Error('Explicit complete semantic coverage mapping is required.');
  for (const key of keys) if (!Array.isArray(coverage[key]) || !coverage[key].length || new Set(coverage[key]).size !== coverage[key].length || coverage[key].some(id => !ids.includes(id))) throw new Error(`Invalid requirement mapping: ${key}`);
  if (ids.some(id => !Object.values(coverage).flat().includes(id))) throw new Error('Unmapped real requirements: resolve scope before approval; never discard them.');
  const steps = [], web = [], browserSessions = new Set(); let n = 0;
  const refs = selected => [...new Set((Array.isArray(selected) ? selected : [selected]).flatMap(key => { if (!coverage[key]) throw new Error(`Unknown semantic key ${key}`); return coverage[key]; }))];
  function request(session, method, path, status, body, assertions = [], captures = []) {
    const id = `q${++n}`;
    return { id, method, path, ...(session ? { session } : {}), ...(body === undefined ? {} : { body }), assertions: [{ id: `${id}_status`, op: Array.isArray(status) ? 'statusIn' : 'status', value: status }, ...assertions.map((item, index) => ({ id: `${id}_a${index}`, ...item }))], ...(captures.length ? { captures: captures.map(([name, path]) => ({ name, path })) } : {}) };
  }
  const add = (key, value) => { const step = { id: `s${steps.length + 1}`, dependsOn: steps.length ? [steps.at(-1).id] : [], requirementIds: refs(key), ...value }; steps.push(step); return step; };
  const api = (key, session, method, path, status, body, assertions, captures) => add(key, { type: 'request', request: request(session, method, path, status, body, assertions, captures) });
  const login = (session, user, key = 'auth') => api(key, session, 'POST', '/api/login', 200, { username: user, password: `${user}-demo` }, [equal('$.user.id', user)]);
  const race = (key, calls, expectedStatuses) => add(key, { type: 'concurrent', requests: calls.map(args => request(...args)), expectedStatuses });
  const restart = key => add(key, { type: 'restart' });
  const b = (key, session, op, target, value) => { browserSessions.add(session); web.push({ id: `b${web.length + 1}`, session, requirementIds: refs(key), op, ...(op === 'goto' ? { path: target } : { testId: target }), ...(['goto', 'click'].includes(op) ? {} : { value }) }); };
  const browserLogin = (session, user) => { b('auth', session, 'goto', '/login'); b('auth', session, 'fill', 'login-username', user); b('auth', session, 'fill', 'login-password', `${user}-demo`); b('auth', session, 'click', 'login-submit'); b(['auth','ui'], session, 'text', 'actor-name', user); };
  function finish() { return freeze({ version: 1, id, name, sessions: [...sessions], limits: { timeoutMs: 120000, requestTimeoutMs: 5000 }, steps, browser: { version: 1, sessions: [...browserSessions], limits: { timeoutMs: 120000, actionTimeoutMs: 8000 }, steps: web } }); }
  api('ui',null,'GET','/login',200,undefined,[{op:'textIncludes',value:'login-submit'}]);
  return { api, login, race, restart, b, browserLogin, finish };
}

// Mapping is a reviewed adapter to a real generated task plan, never a supplied
// engineering plan. Compiler performs scope coverage, DAG and exact task hashing.
export function withTaskScopes(proposal, taskScopes) {
  if (proposal.taskScopes || !Array.isArray(taskScopes) || !taskScopes.length) throw new Error('Supply a fresh, reviewed scope mapping.');
  return freeze({ ...structuredClone(proposal), taskScopes: structuredClone(taskScopes) });
}
