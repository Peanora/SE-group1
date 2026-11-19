import assert from 'node:assert/strict';
import test from 'node:test';
import { draftMissingBrowserLogin } from '../lib/verification-login-revision.mjs';
import { inspectVerificationProposal } from '../lib/verification-contract.mjs';

const requirementIds = ['R-001'];
const status = (id, value) => ({ id, op: 'status', value });
const request = (id, session, path, body, expected, dependsOn = []) => ({
  id, type: 'request', requirementIds, dependsOn,
  request: { id: `${id}-request`, session, method: 'POST', path, body, assertions: [status(`${id}-result`, expected)] },
});
const browser = (id, session, op, rest) => ({ id, session, op, requirementIds, ...rest });
const selectors = (...pairs) => pairs.map(([testId, role]) => ({ testId, role }));

function fixture({ provision = false } = {}) {
  const sessions = ['member-a', 'member-b', ...(provision ? ['manager'] : [])];
  const start = [
    browser('donor-open', 'member-a', 'goto', { path: '/login.html' }),
    browser('donor-user', 'member-a', 'fill', { testId: 'username', value: 'sample-a' }),
    browser('donor-pass', 'member-a', 'fill', { testId: 'password', value: 'fixture-a' }),
    browser('donor-click', 'member-a', 'click', { testId: 'login-submit' }),
  ];
  const definition = {
    version: 1, id: 'login-checks', name: 'Session isolation', sessions,
    steps: [
      ...(provision ? [
        request('manager-login', 'manager', '/api/auth/login', { username: 'sample-manager', password: 'fixture-manager' }, 200),
        request('create-a', 'manager', '/api/admin/users', { username: 'sample-a', password: 'fixture-a', display_name: 'Sample A' }, 201, ['manager-login']),
        request('create-b', 'manager', '/api/admin/users', { username: 'sample-b', password: 'fixture-b', display_name: 'Sample B' }, 201, ['manager-login']),
      ] : []),
      request('a-login', 'member-a', '/api/auth/login', { username: 'sample-a', password: 'fixture-a' }, 200, provision ? ['create-a'] : []),
      request('b-login', 'member-b', '/api/auth/login', { username: 'sample-b', password: 'fixture-b' }, 200, provision ? ['create-b'] : []),
      request('reject-login', 'member-a', '/api/auth/login', { username: 'sample-a', password: 'invalid-fixture' }, 401),
    ],
    browser: { version: 1, sessions, steps: [...start,
      browser('target-open', 'member-b', 'goto', { path: '/inbox.html' }),
      browser('target-list', 'member-b', 'visible', { testId: 'inbox-list', value: true }),
      ...(provision ? [
        browser('manager-open', 'manager', 'goto', { path: '/admin.html' }),
        browser('manager-form', 'manager', 'visible', { testId: 'new-user-form', value: true }),
      ] : []),
      browser('target-session', 'member-b', 'visible', { testId: 'logout-button', value: true }),
    ] },
  };
  const engineeringContract = {
    routes: [{ path: '/api/auth/login', method: 'POST', roles: [], requirementIds },
      ...(provision ? [{ path: '/api/admin/users', method: 'POST', roles: ['OWNER'], requirementIds }] : [])],
    views: [
      { path: '/login.html', selectors: selectors(['username', 'textbox'], ['password', 'textbox'], ['login-submit', 'button']) },
      { path: '/inbox.html', selectors: selectors(['logout-button', 'button'], ['inbox-list', 'list']) },
      ...(provision ? [{ path: '/admin.html', selectors: selectors(['new-user-form', 'form'], ['admin-username', 'textbox'],
        ['admin-display-name', 'textbox'], ['admin-password', 'textbox'], ['admin-create-submit', 'button'], ['admin-create-status', 'status']) }] : []),
    ],
  };
  const evidence = { code: 'browser_login_missing', checkId: 'target-open', session: 'member-b', path: '/inbox.html' };
  const browserReport = { checks: start.map(step => ({ id: `BROWSER-DESKTOP-${step.id}`, passed: true })) };
  return { definition, evidence, engineeringContract, browserReport };
}

const binding = { projectId: 'p1', runId: 'r1', specRevision: 'a'.repeat(64), planRevision: 'b'.repeat(64) };
const check = proposal => inspectVerificationProposal({ proposal, requirements: requirementIds, binding });

test('reuses checked login actions and existing signed-in assertion without altering approved checks', () => {
  const input = fixture(), before = structuredClone(input.definition);
  const result = draftMissingBrowserLogin(input);
  const newSteps = result.proposal.browser.steps.filter(step => step.id.startsWith('prepare-login-'));
  assert.deepEqual(result.repairedSessions, ['member-b', 'member-a']);
  assert.deepEqual(newSteps.filter(step => step.session === 'member-b').map(step => [step.op, step.value]), [
    ['goto', undefined], ['fill', 'sample-b'], ['fill', 'fixture-b'], ['click', undefined], ['visible', true],
  ]);
  assert.deepEqual(newSteps.at(-1).testId, 'logout-button');
  assert.ok(result.proposal.browser.steps.indexOf(newSteps.at(-1)) < result.proposal.browser.steps.findIndex(step => step.id === 'target-open'));
  assert.deepEqual(result.proposal.browser.steps.filter(step => !newSteps.includes(step)), before.browser.steps);
  assert.deepEqual(result.proposal.steps, before.steps);
  assert.deepEqual(input.definition, before);
  assert.notEqual(result.proposal.browser.steps.find(step => step.id === 'target-open'), input.definition.browser.steps.find(step => step.id === 'target-open'));
  assert.ok(check(result.proposal).browser);
});

test('prepares independent browser data only from matching authorized provisioning fixtures', () => {
  const input = fixture({ provision: true });
  const result = draftMissingBrowserLogin(input);
  const steps = result.proposal.browser.steps;
  const start = steps.findIndex(step => step.id === 'donor-open');
  assert.deepEqual(result.repairedSessions, ['member-b', 'member-a', 'manager']);
  assert.ok(start > 0);
  assert.ok(steps.slice(0, start).every(step => step.session === 'manager'));
  assert.deepEqual(steps.slice(0, start).filter(step => step.testId === 'admin-username').map(step => step.value), ['sample-a', 'sample-b']);
  assert.deepEqual(steps.slice(0, start).filter(step => step.testId === 'admin-create-status').map(step => step.value), [true, true]);
  assert.deepEqual(steps.filter(step => !step.id.startsWith('prepare-login-')), input.definition.browser.steps);
  assert.deepEqual(result.proposal.steps, input.definition.steps);
  assert.ok(check(result.proposal).browser);
});

test('refuses to guess when evidence, successful fixtures, selector roles or validated ordering are missing', () => {
  for (const mutate of [
    input => { input.evidence.session = 'other'; },
    input => { input.browserReport.checks.at(-1).passed = false; },
    input => input.definition.browser.steps.pop(),
    input => input.definition.browser.steps.splice(4, 0, browser('anonymous-login', 'member-b', 'goto', { path: '/login.html' })),
    input => { input.engineeringContract.views[2].selectors.find(step => step.testId === 'admin-password').role = 'button'; },
    input => { input.definition.steps.find(step => step.id === 'create-b').request.body.password = 'different-fixture'; },
    input => { input.definition.steps.find(step => step.id === 'create-b').dependsOn = []; },
    input => { input.definition.taskScopes = [{ taskId: 'build', httpStepIds: ['a-login'], browserStepIds: ['target-list'] }]; },
  ]) {
    const input = fixture({ provision: true });
    mutate(input);
    assert.equal(draftMissingBrowserLogin(input), null);
  }
});
