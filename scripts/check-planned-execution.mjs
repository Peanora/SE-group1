import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../server.mjs';
import { contentRevision } from '../lib/planning-review.mjs';
import { createVerificationControl, compileManifest } from '../lib/verification-contract.mjs';
import { startPlannedWebExecution, isPlannedWebTaskAccepted } from '../lib/planned-web-executor.mjs';
import { createProjectCodeModel } from '../lib/project-code-model.mjs';
import { createProjectReviewModel } from '../lib/project-review-model.mjs';
import { readProjectFiles } from '../lib/project-files.mjs';
import { createPlannedDelivery } from '../lib/planned-delivery.mjs';
import { plannedNotes } from '../examples/planned-notes.mjs';
import { inspectPlannedSource } from '../lib/planned-source.mjs';

const mode = process.argv[2];
const repairReport = process.argv.length === 5 && process.argv[3] === '--source' && mode === '--model' ? path.resolve(process.argv[4]) : null;
if ((!repairReport && process.argv.length !== 3) || !['--fixture', '--model'].includes(mode)) {
  console.error('请选择 --fixture（真实隔离/Edge诊断，模型费用0）或 --model（真实编码和Review，会产生用量）。'); process.exitCode = 2;
} else {
  await loadEnv();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outputDir = path.join(root, 'output', 'planned-checks'); await mkdir(outputDir, { recursive: true });
  const binding = { projectId: 'reference-planned-notes', runId: randomUUID(), taskId: 'NOTES', specRevision: contentRevision(plannedNotes.spec), planRevision: contentRevision(plannedNotes.task) };
  const base = Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding[key]]));
  const definition = { proposal: plannedNotes.definition, requirements: plannedNotes.spec.requirements.map(item => item.id), binding: base };
  const control = createVerificationControl(), approval = control.approve({ ...definition, feedback: '受控基准：人工固定联合验收定义，编码前冻结；不作为任意用户项目审批。' });
  const manifest = compileManifest({ ...definition, approval }); control.beginCoding(approval);
  const initialSource = repairReport ? await inspectPlannedSource({ rootDir: outputDir, reportPath: repairReport, binding, writablePaths: plannedNotes.task.tasks.flatMap(task => task.writePaths) }) : undefined;
  const fixture = body => async ({ onReceipt }) => { await onReceipt({ model: 'trusted-notes-fixture', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 }, content: JSON.stringify(body) }); return body; };
  const handle = startPlannedWebExecution({ outputDir, binding, task: plannedNotes.task, manifest, initialSource, assertCurrent: () => true,
    provider: mode === '--model' ? createProjectCodeModel() : fixture({ files: plannedNotes.files }),
    reviewer: mode === '--model' ? createProjectReviewModel() : fixture({ summary: '可信夹具只检验执行基础，不计真实独立模型Review', issues: [], resolutions: [] }),
    providerKind: mode === '--model' ? 'model' : 'trusted_fixture', reviewerKind: mode === '--model' ? 'model' : 'diagnostic',
    maxCalls: mode === '--model' && !initialSource ? 3 : 1, maxReviewCalls: mode === '--model' && !initialSource ? 3 : 1, timeoutMs: 600000,
    onEvent: event => console.log(`[${event.sequence}] ${event.message}`),
  });
  const stop = () => handle.cancel(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const record = await handle.done, gate = record.versions.at(-1)?.acceptance;
    const summary = { kind: 'planned-notes-benchmark', status: record.status, taskAccepted: isPlannedWebTaskAccepted(record, manifest),
      fixture: mode === '--fixture', totalModelCalls: record.totalModelCalls, usage: record.usage, candidateCommit: record.candidateCommit,
      http: gate?.test?.checks.filter(check => check.passed).length ?? 0, httpTotal: gate?.test?.checks.length ?? 0,
      browser: gate?.browser?.checks.filter(check => check.passed).length ?? 0, browserTotal: gate?.browser?.checks.length ?? 0,
      review: gate?.review?.status ?? null, terminationConfirmed: record.terminationConfirmed, report: record.reportPath ?? null };
    if (summary.taskAccepted) {
      const zip = await createPlannedDelivery({ record, manifest, files: await readProjectFiles(record.workspace), requirements: plannedNotes.requirements, spec: plannedNotes.spec, tasks: plannedNotes.task.tasks });
      summary.archive = path.join(path.dirname(record.reportPath), 'planned-notes-source.zip'); await writeFile(summary.archive, zip, { flag: 'wx' });
    }
    await writeFile(path.join(path.dirname(record.reportPath ?? path.join(outputDir, 'unstarted.json')), `summary-${binding.runId}.json`), JSON.stringify(summary, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(summary, null, 2));
    if (mode === '--model' ? !summary.taskAccepted : record.status !== 'diagnostic_passed') process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
