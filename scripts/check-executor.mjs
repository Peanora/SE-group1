import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadEnv } from '../server.mjs';
import { createCodeModel } from '../lib/code-model.mjs';
import { createWindowsSandbox } from '../lib/windows-sandbox.mjs';
import { startTaskExecution } from '../lib/task-executor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 1 || !['--model', '--fixture'].includes(args[0])) {
  console.error('请选择 --fixture（可信候选诊断，不调用模型）或 --model（真实编码请求，会产生模型用量）。');
  process.exitCode = 2;
} else {
  await loadEnv();
  const fixture = args[0] === '--fixture';
  const provider = fixture ? async () => ({ files: [{ path: 'src/borrow.mjs', content: await readFile(path.join(root, 'examples/library-borrow.fixture.mjs'), 'utf8') }], usage: { inputTokens: null, outputTokens: null } }) : createCodeModel();
  const sandbox = createWindowsSandbox();
  const execution = startTaskExecution({
    outputDir: path.resolve(process.env.EXECUTION_OUTPUT_DIR || path.join(root, 'output', 'executions')),
    provider, sandbox, providerKind: fixture ? 'trusted_fixture' : 'model', maxCalls: fixture ? 1 : 2, timeoutMs: 180_000,
    onEvent: item => console.log(`[${item.sequence}] ${item.message}`),
  });
  const stop = () => { console.log('已请求停止，等待执行退出确认。'); execution.cancel(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const record = await execution.done;
    // This evidence label distinguishes model execution from trusted diagnostic fixtures.
    console.log(JSON.stringify({ mode: fixture ? 'trusted_fixture' : 'model', status: record.status, calls: record.calls,
      baseCommit: record.baseCommit, candidateCommit: record.candidateCommit, report: record.reportPath,
      checksPassed: record.versions.at(-1)?.check?.checks.filter(item => item.passed).length ?? 0,
      checksTotal: record.validationManifest.count, acceptanceStatus: record.acceptanceStatus, error: record.error }, null, 2));
    if (record.status !== 'executed') process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
