import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { factoryBinaryPath } from '../lib/factory-release.mjs';

const exec = promisify(execFile);
const binary = factoryBinaryPath(fileURLToPath(new URL('../', import.meta.url)));
const installed = await access(binary).then(() => true, () => false);
const windows = process.platform === 'win32';
const prefix = 'taskflow-factory-native-github-';
const repository = 'octocat/example';
const remoteName = `https://github.com/${repository}.git`;
const issue = { number: 42, title: 'Fixture issue', body: 'Use local fixture evidence.', labels: [], state: 'open',
  url: `https://github.com/${repository}/issues/42`, author: { login: 'octocat' }, comments: [] };
const pull = `https://github.com/${repository}/pull/58`;

async function mockGh(directory) {
  const gh = path.join(directory, windows ? 'fake-gh.cmd' : 'fake-gh.sh');
  const payload = path.join(directory, 'issue.json');
  await writeFile(payload, JSON.stringify(issue));
  const script = windows ? [
    '@echo off',
    'if "%1"=="auth" goto auth',
    'if "%1"=="issue" goto issue',
    'if "%1"=="pr" if "%2"=="list" goto prlist',
    'if "%1"=="pr" if "%2"=="create" goto prcreate',
    'exit /b 1',
    ':auth',
    'echo Logged in to github.com account octocat keyring',
    'exit /b 0',
    ':issue',
    `type "${payload}"`,
    'exit /b 0',
    ':prlist',
    'echo []',
    'exit /b 0',
    ':prcreate',
    `echo ${pull}`,
    'exit /b 0',
  ].join('\r\n') : [
    '#!/bin/sh', 'case "$1 $2" in',
    "  'auth status') echo 'Logged in to github.com account octocat keyring' ;;",
    `  'issue view') cat '${payload.replaceAll("'", "'\\''")}' ;;`,
    "  'pr list') echo '[]' ;;",
    `  'pr create') echo '${pull}' ;;`,
    '  *) exit 1 ;;', 'esac',
  ].join('\n');
  await writeFile(gh, script + (windows ? '\r\n' : '\n'), { mode: 0o700 });
  return gh;
}

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(parent, prefix));
  let child, stopped;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (stopped) await stopped;
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  const gh = await mockGh(directory);
  const allow = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|HOME)$/iu;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allow.test(key))),
    FACTORY_GH_BIN: gh, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  const workspace = path.join(directory, 'workspace');
  const remote = path.join(directory, 'remote.git');
  await mkdir(workspace);
  await writeFile(path.join(workspace, '.env'), '');
  const run = (command, args) => exec(command, args, { cwd: workspace, env, timeout: 15_000, windowsHide: true });
  const git = (...args) => run('git', args);
  await git('init', '--bare', '--initial-branch=main', '--template=', remote);
  await git('init', '--initial-branch=main', '--template=');
  await git('config', '--local', 'user.name', 'Factory fixture');
  await git('config', '--local', 'user.email', 'factory@localhost');
  await git('commit', '--allow-empty', '-m', 'Fixture starting commit');
  const localRemote = pathToFileURL(remote).href;
  await git('remote', 'add', 'origin', remoteName);
  await git('config', '--local', `url.${localRemote}.insteadOf`, remoteName);
  await git('remote', 'set-url', '--push', 'origin', localRemote);
  assert.equal((await git('remote', 'get-url', '--all', 'origin')).stdout.trim(), localRemote);
  assert.equal((await git('remote', 'get-url', '--push', '--all', 'origin')).stdout.trim(), localRemote);
  await git('push', 'origin', 'main');
  assert.equal((await run(binary, ['--version'])).stdout.trim(), 'factory 1.0.5');
  await run(binary, ['init']);

  const agent = path.join(directory, 'agent.mjs');
  await writeFile(agent, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const role = process.argv[2];",
    "const input = readFileSync(0, 'utf8');",
    "if (role === 'planner' && !input.includes('Fixture issue')) process.exit(2);",
    "if (role === 'worker') writeFileSync('fixture-issue.txt', 'local evidence\\n');",
    "const outputs = { planner: { objective: 'Fixture issue', tasks: [{ id: 'T1', title: 'Local task', objective: 'Write local evidence', dependencies: [], acceptanceCriteria: ['Evidence exists'] }] },",
    "  worker: { commands: [], tests: [] }, reviewer: { decision: 'approve', reason: 'Local evidence accepted' } };",
    "console.log(JSON.stringify(outputs[role]));",
  ].join('\n'));

  child = spawn(binary, ['start', '--port', '0', '--no-browser'], { cwd: workspace, env,
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
  stopped = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  let startup = '';
  let origin;
  child.stdout.on('data', chunk => {
    startup += chunk;
    origin ??= /Agentic Software Factory running at (http:\/\/127\.0\.0\.1:[0-9]+)/u.exec(startup)?.[1];
  });
  await waitFor(() => origin, '直接启动固定版本 Factory');
  async function api(route, method = 'GET', body) {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(8000), redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const raw = await response.text();
    return { status: response.status, data: raw.length ? JSON.parse(raw) : null };
  }
  const config = await api('/api/config');
  assert.equal(config.status, 200);
  const roles = ['planner', 'worker', 'reviewer'];
  config.data.agents = Object.fromEntries(roles.map(role => [role, {
    kind: 'custom', command: process.execPath, args: [agent, role], prompt_transport: 'stdin',
  }]));
  config.data.role_assignments = roles.map(role => ({ role, agent: role, preferred: true }));
  assert.equal((await api('/api/config', 'PUT', config.data)).status, 204);
  return { api, git, remote };
}

async function waitFor(check, label) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = await check();
    if (result) return result;
    assert.ok(Date.now() < deadline, `等待超时：${label}`);
    await delay(50);
  }
}

test('固定版本 Factory 通过模拟 gh 导入 Issue 并把 PR 分支交付到纯本地远端', {
  skip: !installed && '先运行 npm run factory:install', timeout: 60_000,
}, async t => {
  const { api, git, remote } = await fixture(t);
  const status = await api('/api/github/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.connected, true);
  assert.equal(status.data.user, 'octocat');
  assert.equal(status.data.repository.repository, repository);
  assert.equal((await api('/api/runs/from-issue', 'POST', { issue: 'https://github.com/other/example/issues/42' })).status, 400);

  const imported = await api('/api/runs/from-issue', 'POST', { issue: '#42' });
  assert.equal(imported.status, 202, JSON.stringify(imported.data));
  const { id } = imported.data;
  const route = `/api/runs/${id}`, branch = `factory/run-${id}`;
  async function waitForRun(state) {
    return waitFor(async () => {
      const { data } = await api(route);
      assert.ok(!['failed', 'blocked', 'cancelled'].includes(data.run.status), JSON.stringify(data.attempts));
      return data.run.status === state && data;
    }, state);
  }
  await waitForRun('planned');
  const before = await api(route + '/pr-preview');
  assert.equal(before.status, 200);
  assert.equal(before.data.eligible, false);
  assert.equal((await api(route + '/pull-request', 'POST', { title: 'Fixture delivery', body: 'Local only' })).status, 409);

  assert.equal((await api(route + '/start', 'POST')).status, 202);
  const completed = await waitForRun('completed');
  assert.equal(completed.attempts[0].status, 'approved');
  const preview = await api(route + '/pr-preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.data.eligible, true);
  assert.equal(preview.data.head, branch);
  assert.equal(preview.data.base, 'main');
  assert.match(preview.data.body, /Closes #42/u);

  const delivered = await api(route + '/pull-request', 'POST', { title: 'Fixture delivery', body: 'Local-only evidence', draft: true });
  assert.equal(delivered.status, 201, JSON.stringify(delivered.data));
  assert.equal(delivered.data.state, 'published');
  assert.equal(delivered.data.pullRequest.url, pull);
  assert.equal(delivered.data.pullRequest.isDraft, true);
  const published = await git('--git-dir', remote, 'show', `${branch}:fixture-issue.txt`);
  assert.equal(published.stdout.trim(), 'local evidence');
  const main = await git('--git-dir', remote, 'ls-tree', 'main', 'fixture-issue.txt');
  assert.equal(main.stdout, '');
  const duplicate = await api(route + '/pull-request', 'POST', { title: 'Duplicate', body: 'Local-only evidence' });
  assert.deepEqual(duplicate.data.pullRequest, delivered.data.pullRequest);
  const graph = await api('/api/graph');
  assert.ok(graph.data.nodes.some(node => node.kind === 'github_issue' && node.meta.number === 42));
  assert.ok(graph.data.nodes.some(node => node.kind === 'github_pr' && node.meta.number === 58));
});
