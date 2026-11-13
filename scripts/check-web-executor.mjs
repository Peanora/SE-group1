import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server.mjs';
import { createProjectCodeModel } from '../lib/project-code-model.mjs';
import { createProjectReviewModel } from '../lib/project-review-model.mjs';
import { isWebTaskAccepted, startWebExecution } from '../lib/web-executor.mjs';
import { webProfile } from '../lib/web-profile.mjs';
import { webManifest } from '../lib/web-tests.mjs';
import { browserManifest } from '../lib/web-browser-tests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 3 || process.argv[2] !== '--model') {
  console.error('请选择 --model：真实生成图书借阅Web项目并执行独立验收，会产生模型用量。');
  process.exitCode = 2;
} else {
  await loadEnv();
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const execution = startWebExecution({
    outputDir: path.join(root, 'output', 'web-executions'),
    binding: { projectId: 'reference-library-web', runId: 'reference-run-v1', taskId: webProfile.id,
      specRevision: hash(webProfile.task), planRevision: hash({ profileId: webProfile.id, web: webManifest.hash, browser: browserManifest.hash }) },
    provider: createProjectCodeModel(), reviewer: createProjectReviewModel(), maxCalls: 3, maxReviewCalls: 3, timeoutMs: 600_000,
    onEvent: event => console.log(`[${event.sequence}] ${event.message}`),
  });
  const stop = () => { console.log('已请求停止，等待实际进程退出。'); execution.cancel(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const record = await execution.done, latest = record.versions.at(-1), gate = latest?.acceptance;
    console.log(JSON.stringify({ profileId: record.profileId, status: record.status, taskAccepted: isWebTaskAccepted(record),
      codingCalls: record.calls, reviewCalls: record.reviewCalls, totalModelCalls: record.totalModelCalls, usage: record.usage,
      baseCommit: record.baseCommit, candidateCommit: record.candidateCommit, versions: record.versions.length,
      http: { passed: gate?.test?.checks?.filter(item => item.passed).length ?? 0, total: webManifest.count },
      browser: { passed: gate?.browser?.checks?.filter(item => item.passed).length ?? 0, total: browserManifest.count },
      review: gate?.review?.status ?? null, report: record.reportPath ?? null, error: record.error }, null, 2));
    if (!isWebTaskAccepted(record)) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
