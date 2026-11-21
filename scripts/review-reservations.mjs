import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { minimalEnv, runProcess } from '../lib/managed-process.mjs';
import { createProjectReviewModel, projectReviewPolicy } from '../lib/project-review-model.mjs';
import { reconcilePlannedReviewIssues } from '../lib/planned-review-issues.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = 'src/promote.mjs';
const specPath = 'examples/quality-benchmarks/reservations.md';
const defect = '  const head = queued.find(waiter => waiter.id === requestedId);';
const fix = '  const head = queued.reduce((first, waiter) => first === null || waiter.sequence < first.sequence ? waiter : first, null);';
const source = selection => [
  'export function promotableWaiter(waitlist, resourceId, slot, requestedId) {',
  "  const queued = waitlist.filter(waiter => waiter.resourceId === resourceId && waiter.slot === slot && waiter.status === 'queued');",
  selection,
  '  return head && head.id === requestedId ? head : null;',
  '}', '',
].join('\n');

// Simulate only the provider transport. The production adapter numbers source lines,
// validates the response and derives the displayed evidence from those same lines.
async function fixtureResponse(_url, request) {
  const { files, previousIssues } = JSON.parse(JSON.parse(request.body).messages[1].content);
  const badLine = files[0].lines.find(entry => entry.text === defect);
  const fixedLine = files[0].lines.find(entry => entry.text === fix);
  if (!badLine && !fixedLine) throw new Error('离线演示源码与预期不符。');
  const message = '按请求的 ID 查找会跳过同一资源和时段内 sequence 更小的候补，允许后到的成员先取得占位。';
  const review = {
    summary: badLine ? 'FIFO 队首校验缺失。' : '按最早 sequence 确认队首。',
    issues: badLine && !previousIssues.length ? [{ file: files[0].path, line: badLine.line, severity: 'blocking', message }] : [],
    resolutions: previousIssues.map(({ id }) => ({ id, status: badLine ? 'open' : 'resolved',
      reason: badLine ? message : '先选出同资源、同时段内 sequence 最小的 queued 项，再比较请求 ID。' })),
  };
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(review) } }] });
}

export async function reviewReservations(mode, output = path.join(root, 'output', 'reservation-review')) {
  if (!['--fixture', '--model'].includes(mode)) throw new Error('请选择 --fixture（离线演示）或 --model（两次真实模型审查，会产生用量）。');
  const fixture = mode === '--fixture';
  const reviewer = createProjectReviewModel(fixture
    ? { config: { baseUrl: 'https://fixture.invalid', model: 'offline-fifo-fixture' }, fetchImpl: fixtureResponse }
    : {});
  const spec = await readFile(path.join(root, specPath), 'utf8');
  const rule = spec.split(/\r?\n/u).find(line => line.startsWith('| POST /api/waitlist/:id/promote |'));
  if (!rule) throw new Error('找不到 V0 的已确认提升规则。');
  const task = [
    '当前审查范围为预约 V0 的候补队首选择函数。', rule,
    '调用方负责事务、鉴权、版本和空位校验。输入为真实的候补记录，sequence 为唯一递增整数，数组顺序不保证。',
    '函数应返回可提升的请求记录；不能提升时返回 null，调用方据此拒绝请求。',
  ].join('\n');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, fixture ? 'fixture-' : 'model-'));
  const workspace = path.join(directory, 'candidate');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  async function git(...args) {
    const result = await runProcess('git', ['-c', 'user.name=Taskflow Demo', '-c', 'user.email=demo@example.invalid',
      '-c', 'core.hooksPath=no-hooks', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: workspace, env: { ...minimalEnv({ PATH: process.env.PATH }), GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(directory, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.exitCode !== 0 || result.stopReason || result.truncated || !result.terminationConfirmed) {
      throw new Error(`生成或读取演示提交失败（git ${args[0]}）。`);
    }
    return result.stdout;
  }
  await git('init', '--quiet');
  const reports = [];
  let previousIssues = [];
  for (const [selection, label] of [[defect, 'Initial promotion selection'], [fix, 'Check FIFO head before promotion']]) {
    await writeFile(path.join(workspace, sourcePath), source(selection));
    await git('add', '--', sourcePath);
    await git('commit', '--quiet', '-m', label);
    const commit = (await git('rev-parse', 'HEAD')).trim();
    const files = [{ path: sourcePath, content: await git('cat-file', 'blob', `${commit}:${sourcePath}`) }];
    const report = {
      kind: fixture ? 'offline_fixture' : 'independent_model', candidateCommit: commit,
      sourceHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      policyHash: projectReviewPolicy.hash, specPath, task, previousCommit: reports.at(-1)?.candidateCommit ?? null,
    };
    try {
      const result = await reviewer({ task, files, previousIssues, signal: AbortSignal.timeout(120_000) });
      Object.assign(report, { status: 'completed', summary: result.summary, model: result.model, usage: result.usage,
        resolutions: result.resolutions, ...reconcilePlannedReviewIssues({ result, previousIssues, commit }) });
    } catch (error) {
      Object.assign(report, { status: 'incomplete', error: error.message, issues: previousIssues,
        openBlockingIssues: previousIssues.length });
    }
    const reportPath = path.join(directory, `${commit}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    reports.push(report);
    if (report.status !== 'completed') break;
    previousIssues = report.issues.filter(issue => issue.severity === 'blocking' && issue.status === 'open');
  }
  const [initial, repaired] = reports;
  const demonstrated = initial.openBlockingIssues > 0 && repaired?.status === 'completed' && repaired.openBlockingIssues === 0;
  return { directory, reports, demonstrated };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('仅接受一个模式参数 --fixture 或 --model。');
    if (mode === '--model') {
      try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const { directory, reports, demonstrated } = await reviewReservations(mode);
    console.log(mode === '--fixture' ? '预约队首离线演示（模拟模型响应）' : '预约队首独立模型审查');
    for (const report of reports) {
      console.log(`\n${report.candidateCommit}  ${report.status}  ${report.summary ?? report.error}`);
      for (const issue of report.issues) {
        console.log(`  ${issue.id}  ${issue.severity}/${issue.status}  ${issue.file}:${issue.line}  ${issue.message}`);
        console.log(`  原始证据  ${issue.evidence}`);
        if (issue.resolution) console.log(`  复核依据  ${issue.resolution}`);
      }
      console.log(`  报告  ${path.join(directory, report.candidateCommit + '.json')}`);
    }
    if (!demonstrated) {
      console.error('本次演示未取得“原提交有阻塞、新提交逐项关闭”的完整记录。');
      process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
