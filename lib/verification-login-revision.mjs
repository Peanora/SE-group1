import { normalizeBrowserScenario } from './browser-scenario-contract.mjs';

const LOGIN = '/api/auth/login';
const USERS = '/api/admin/users';
const successful = request => request.assertions.some(({ op, value }) => op === 'status' && [200, 201].includes(value)
  || op === 'statusIn' && Array.isArray(value) && value.length > 0 && value.every(status => [200, 201].includes(status)));
const string = value => typeof value === 'string' && value.length > 0;
const exactStrings = (body, keys) => body && Object.keys(body).length === keys.length && keys.every(key => string(body[key]));
const only = items => items.length === 1 ? items[0] : undefined;
const testIds = view => new Map(view?.selectors?.map(({ testId, role }) => [testId, role]));
const isLoginPage = path => /^\/login(?:\.html)?$/u.test(path);

function findLoginForm({ steps, logins, evidenceIndex, views, browserReport }) {
  const sessions = new Set(steps.slice(0, evidenceIndex).map(step => step.session));
  return only([...sessions].flatMap(session => {
    const fixture = logins.get(session)?.request.body;
    const sequence = steps.filter(step => step.session === session);
    if (!fixture || sequence[0]?.op !== 'goto' || !isLoginPage(sequence[0].path)) return [];
    const clickIndex = sequence.findIndex(step => step.op === 'click');
    const prefix = sequence.slice(0, clickIndex + 1);
    if (clickIndex < 3 || prefix.some(step => steps.indexOf(step) >= evidenceIndex)) return [];
    if (!['DESKTOP', 'MOBILE'].some(view => prefix.every(step => browserReport?.checks?.some(check => check.id === `BROWSER-${view}-${step.id}` && check.passed === true)))) return [];

    const selectors = testIds(views.get(prefix[0].path));
    const fills = prefix.filter(step => step.op === 'fill');
    const username = only(fills.filter(step => step.value === fixture.username && selectors.get(step.testId) === 'textbox'));
    const password = only(fills.filter(step => step.value === fixture.password && selectors.get(step.testId) === 'textbox'));
    const submit = prefix.at(-1);
    if (fills.length !== 2 || !username || !password || username.testId === password.testId || selectors.get(submit.testId) !== 'button') return [];
    if (prefix.slice(1, -1).some(step => step.op !== 'fill' && (step.op !== 'visible' || !step.value || !selectors.has(step.testId)))) return [];
    return [{ prefix, username, password, submit }];
  }));
}

function findAccountProvisioning({ definition, form, logins, steps, views, routes, target }) {
  const createRoute = only(routes.filter(route => route.method === 'POST' && route.path === USERS && route.roles?.length));
  const required = [form.prefix[0].session, target.session];
  const matches = session => {
    const login = logins.get(session)?.request.body;
    return definition.steps.filter(step => step.type === 'request' && step.request.method === 'POST' && step.request.path === USERS
      && successful(step.request) && step.request.body?.username === login?.username);
  };
  const creates = required.map(matches);
  // Provisioning is unnecessary where the approved HTTP flow uses already available accounts.
  if (creates.every(items => items.length === 0)) return null;
  const operator = creates[0][0]?.request.session;
  const operatorLogin = logins.get(operator);
  const ownSteps = steps.filter(step => step.session === operator);
  const page = ownSteps[0];
  const selectors = testIds(views.get(page?.path));
  const fields = [['username', 'admin-username'], ['display_name', 'admin-display-name'], ['password', 'admin-password']];
  const submit = 'admin-create-submit', status = 'admin-create-status';
  const formCheck = ownSteps.slice(1).find(step => step.op === 'visible' && step.value && selectors.get(step.testId) === 'form');
  if (!createRoute || !operatorLogin || required.includes(operator) || page?.op !== 'goto' || !formCheck
    || !fields.every(([, selector]) => selectors.get(selector) === 'textbox') || selectors.get(submit) !== 'button' || selectors.get(status) !== 'status'
    || creates.some((items, index) => items.length !== 1 || items[0].request.session !== operator || !items[0].dependsOn.includes(operatorLogin.id)
      || !exactStrings(items[0].request.body, ['username', 'password', 'display_name'])
      || items[0].request.body.password !== logins.get(required[index]).request.body.password)
    || !creates.flat().every(step => step.requirementIds.some(requirement => createRoute.requirementIds.includes(requirement)))) return false;
  return { operator, page, fields, submit, status, creates: [...new Set(creates.flat())], formCheck };
}

/** Prepare an unapproved draft from a confirmed engineering contract and one execution's checks. */
export function draftMissingBrowserLogin({ definition, evidence, engineeringContract, browserReport } = {}) {
  const steps = definition?.browser?.steps;
  const routes = engineeringContract?.routes, pages = engineeringContract?.views;
  if (!Array.isArray(steps) || !Array.isArray(routes) || !Array.isArray(pages) || evidence?.code !== 'browser_login_missing'
    || !routes.some(route => route.method === 'POST' && route.path === LOGIN)) return null;
  const index = steps.findIndex(step => step.id === evidence.checkId && step.session === evidence.session && step.path === evidence.path && step.op === 'goto');
  if (index < 0 || steps.slice(0, index).some(step => step.session === evidence.session)) return null;
  const target = steps[index], views = new Map(pages.map(view => [view.path, view]));
  const targetIds = testIds(views.get(target.path));
  const remaining = steps.slice(index + 1).filter(step => step.session === target.session);
  const nextPage = remaining.findIndex(step => step.op === 'goto');
  const onTargetPage = nextPage < 0 ? remaining : remaining.slice(0, nextPage);
  const landed = onTargetPage.find(step => step.op === 'visible' && step.value && step.testId === 'logout-button' && targetIds.get(step.testId) === 'button');
  if (!landed) return null;

  const loginRows = definition.steps.filter(step => step.type === 'request' && step.request.method === 'POST' && step.request.path === LOGIN
    && exactStrings(step.request.body, ['username', 'password']) && successful(step.request));
  const logins = new Map(definition.browser.sessions.map(session => [session, only(loginRows.filter(row => row.request.session === session))]));
  if (!logins.get(target.session)) return null;
  const form = findLoginForm({ steps, logins, evidenceIndex: index, views, browserReport });
  if (!form) return null;
  const provision = findAccountProvisioning({ definition, form, logins, steps, views, routes, target });
  if (provision === false) return null;

  // The existing task closure is limited to one browser session at a time.
  if (provision && definition.taskScopes?.length) return null;
  const ids = new Set(steps.map(step => step.id));
  let serial = 0;
  const add = (step, changes = {}) => {
    let next; do { next = `prepare-login-${++serial}`; } while (ids.has(next));
    ids.add(next);
    return { ...step, ...changes, id: next };
  };
  const copyLogin = session => form.prefix.map(step => {
    const field = step === form.username ? 'username' : step === form.password ? 'password' : null;
    return add(step, { session, ...(field ? { value: logins.get(session).request.body[field] } : {}) });
  });
  const setup = [];
  if (provision) {
    const { operator, page, fields, submit, status, creates, formCheck } = provision;
    setup.push(...copyLogin(operator), add(landed, { session: operator }), add(page), add(formCheck));
    for (const step of creates) {
      const common = { session: operator, requirementIds: step.requirementIds };
      for (const [field, selector] of fields) setup.push(add({ ...common, op: 'fill', testId: selector, value: step.request.body[field] }));
      setup.push(add({ ...common, op: 'click', testId: submit }), add({ ...common, op: 'visible', testId: status, value: true }));
    }
  }

  const donor = form.prefix[0].session;
  const browserSteps = steps.flatMap(step => [
    ...(provision && step === form.prefix[0] ? setup : []),
    ...(step === target ? [...copyLogin(target.session), add(landed)] : []),
    step,
    ...(step === form.submit ? [add(landed, { session: donor })] : []),
  ]);
  const proposal = structuredClone({ ...definition, browser: { ...definition.browser, steps: browserSteps } });
  const requirements = [...new Set(browserSteps.flatMap(step => step.requirementIds))];
  try { normalizeBrowserScenario(proposal.browser, requirements); } catch { return null; }
  return { proposal, repairedSessions: [...new Set([target.session, donor, ...(provision ? [provision.operator] : [])])] };
}
