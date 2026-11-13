import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server.mjs';
import { createProjectReviewModel } from '../lib/project-review-model.mjs';
import { inspectWebRecheckSource, startWebRecheck } from '../lib/web-recheck.mjs';
import { isWebTaskAccepted } from '../lib/web-executor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function optionsFor(args) {
  const options = { executionRoot: path.join(root, 'output', 'web-executions'), run: false, model: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('参数不能重复。'); seen.add(flag);
    if (flag === '--run') options.run = true;
    else if (flag === '--model-review') options.model = true;
    else if (flag === '--record' || flag === '--execution-root') {
      const value = args[++index];
      if (!value || value.startsWith('--') || !path.isAbsolute(value)) throw new Error('记录与执行根必须是可信绝对路径。');
      options[flag === '--record' ? 'sourceReportPath' : 'executionRoot'] = value;
    } else throw new Error('未知参数。');
  }
  if (!options.sourceReportPath || options.run !== options.model) throw new Error('默认只读检查；付费复验必须同时指定 --run --model-review。');
  return options;
}

try {
  const options = optionsFor(process.argv.slice(2));
  if (!options.run) {
    const { source, summary } = await inspectWebRecheckSource(options);
    console.log(JSON.stringify({ mode: 'inspect', sourceStatus: source.status, sourceAcceptanceStatus: source.acceptanceStatus,
      provenance: summary, codingCallsThisInspection: 0, reviewCallsThisInspection: 0,
      note: '仅校验原始私有历史与固定源码；没有新验收结论，没有启动应用或调用模型。' }, null, 2));
  } else {
    await loadEnv();
    const execution = startWebRecheck({ ...options, reviewer: createProjectReviewModel(),
      onEvent: item => console.log(`[${item.sequence}] ${item.message}`) });
    const stop = () => { console.log('已请求停止，等待运行进程结束。'); execution.cancel(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const record = await execution.done, version = record.versions.at(-1), acceptance = version?.acceptance;
      console.log(JSON.stringify({ mode: 'recheck', id: record.id, status: record.status, taskAccepted: isWebTaskAccepted(record),
        candidateCommit: record.candidateCommit, codingCalls: record.calls, reviewCalls: record.reviewCalls,
        totalModelCalls: record.totalModelCalls, reviewUsage: record.usage, provenance: record.provenance,
        selfCheck: version?.selfCheck?.status ?? null, http: acceptance?.test?.status ?? null,
        browser: acceptance?.browser?.status ?? null, review: acceptance?.review?.status ?? null,
        report: record.reportPath ?? null, error: record.error }, null, 2));
      if (!isWebTaskAccepted(record)) process.exitCode = 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
} catch {
  // Private reports, model transport details and credentials never enter CLI errors.
  console.error('无法检查该受控记录，或复验配置无效。用法：node scripts/recheck-web.mjs --record <绝对execution.json> [--execution-root <可信绝对目录>] [--run --model-review]');
  process.exitCode = 2;
}
