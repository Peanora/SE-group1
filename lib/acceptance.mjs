import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { contentRevision } from './planning-review.mjs';
import { revalidateWebArchive } from './web-archive.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const gitCommit = () => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; } };
const jsonHash = value => contentRevision(value);

// Planning ZIPs are stored (uncompressed) by lib/zip.mjs. Parse only that format,
// so the acceptance check can prove the package contains the expected documents.
function storedZipEntries(bytes) {
  let end = -1;
  for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 65557); i >= min; i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('下载的文档包不是有效ZIP。');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (count < 1 || count > 100 || offset + size !== end) throw new Error('下载的文档包目录无效。');
  const entries = new Map();
  let at = offset, total = 0;
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('下载的文档包目录损坏。');
    const method = bytes.readUInt16LE(at + 10), compressed = bytes.readUInt32LE(at + 20), original = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (method !== 0 || compressed !== original || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('下载的文档包条目不是受支持的存储格式。');
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localName + localExtra;
    if (start + original > offset || entries.has(name)) throw new Error('下载的文档包条目重叠或重复。');
    entries.set(name, bytes.subarray(start, start + original));
    total += original; if (total > 8 * 1024 * 1024) throw new Error('下载的文档包超过验收上限。');
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function planProjection(run) {
  const artifact = run.artifacts.find(item => item.name === 'plan.json');
  if (!artifact) throw new Error('运行没有plan.json产物。');
  const plan = JSON.parse(artifact.content);
  delete plan.runId;
  delete plan.project;
  for (const approval of Object.values(plan.approvals ?? {})) if (approval) delete approval.at;
  return plan;
}

async function runOnce({ fixturePath, content, index, outDir, timeoutMs }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'taskflow-acceptance-data-'));
  let app;
  try {
    app = await createApp({ dataDir, stepDelayMs: 0, executionService: null, sourceChangeService: null });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (pathname, { method = 'GET', body } = {}) => {
      const response = await fetch(`${base}${pathname}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const text = await response.text();
      let value;
      try { value = JSON.parse(text); } catch { value = text; }
      if (!response.ok) throw new Error(`${method} ${pathname} 返回 ${response.status}：${typeof value === 'string' ? value.slice(0, 200) : value?.error || '请求失败'}`);
      return { response, value };
    };
    const { value: created } = await request('/api/projects', { method: 'POST', body: { name: '验收示例', filename: path.basename(fixturePath), content } });
    const project = created.project;
    const { value: started } = await request(`/api/projects/${encodeURIComponent(project.id)}/runs`, { method: 'POST', body: { mode: 'local' } });
    const runPath = `/api/projects/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(started.run.id)}`;
    const deadline = Date.now() + timeoutMs;
    const waitRun = async predicate => {
      for (;;) {
        const { value } = await request(runPath);
        const run = value.run;
        if (run.status === 'failed') throw new Error(`验收运行失败：${run.stages.find(stage => stage.status === 'failed')?.error || '未知阶段失败'}`);
        if (predicate(run)) return run;
        if (Date.now() >= deadline) throw new Error('等待验收运行状态超时。');
        await delay(20);
      }
    };
    let run = await waitRun(item => item.status === 'awaiting_spec');
    const initialQuestions = run.specQuestions?.length ?? 0;
    const answers = Object.fromEntries((run.specQuestions ?? []).filter(question => question.blocking && !String(question.answer ?? '').trim())
      .map(question => [question.id, '验收演示自动回答：首版按示例需求已明确范围；本项不扩展，负责人、优先级和排期由项目团队后续确认。']));
    if (Object.keys(answers).length) {
      const previous = run.specRevision;
      await request(`${runPath}/action`, { method: 'POST', body: { action: 'revise_spec', revision: previous, spec: run.spec, answers } });
      run = await waitRun(item => item.status === 'awaiting_spec' && item.specRevision !== previous);
    }
    const unanswered = (run.specQuestions ?? []).filter(question => question.blocking && !String(question.answer ?? '').trim()).length;
    if (unanswered) throw new Error(`自动验收仍有 ${unanswered} 个阻塞问题未回答。`);
    await request(`${runPath}/action`, { method: 'POST', body: { action: 'approve_spec', revision: run.specRevision } });
    run = await waitRun(item => item.status === 'awaiting_review');
    if (!run.review?.passed) throw new Error('计划结构检查未通过。');
    await request(`${runPath}/action`, { method: 'POST', body: { action: 'approve_plan', revision: run.planRevision, specRevision: run.specRevision } });
    run = await waitRun(item => item.status === 'succeeded');
    const download = await fetch(`${base}${runPath}/download`);
    if (!download.ok) throw new Error(`文档包下载失败：HTTP ${download.status}`);
    const zip = Buffer.from(await download.arrayBuffer()), entries = storedZipEntries(zip);
    const expected = ['requirements.md', 'spec.md', 'architecture.md', 'task.md', 'review.md', 'handoff.md', 'plan.json'];
    const expectedArtifacts = expected.filter(name => name !== 'requirements.md');
    const missing = expected.filter(name => !entries.has(name));
    if (missing.length) throw new Error(`文档包缺少文件：${missing.join('、')}`);
    const documents = Object.fromEntries(expected.filter(name => name !== 'plan.json').map(name => [name, sha256(entries.get(name))]));
    const projection = planProjection(run);
    const artifacts = run.artifacts.map(item => ({ name: item.name, bytes: Buffer.byteLength(item.content), sha256: sha256(item.content) }));
    const modelCalls = Number(run.specificationCalls ?? 0) + Number(run.engineeringCalls ?? 0);
    const zipPath = path.join(outDir, `run-${index}.zip`);
    await writeFile(zipPath, zip);
    const checks = [
      { id: 'planning-succeeded', passed: run.status === 'succeeded', detail: run.status },
      { id: 'local-mode-no-model', passed: run.mode === 'local' && modelCalls === 0, detail: `${run.mode}, calls=${modelCalls}` },
      { id: 'requirements-present', passed: (run.spec?.requirements?.length ?? 0) > 0, detail: `${run.spec?.requirements?.length ?? 0}` },
      { id: 'tasks-present', passed: (run.tasks?.length ?? 0) > 0, detail: `${run.tasks?.length ?? 0}` },
      { id: 'review-passed', passed: run.review?.passed === true, detail: String(run.review?.passed) },
      { id: 'artifacts-complete', passed: expectedArtifacts.every(name => run.artifacts.some(item => item.name === name)), detail: run.artifacts.map(item => item.name).join(',') },
      { id: 'download-zip-valid', passed: entries.size === expected.length && !missing.length, detail: `${entries.size} files` },
      { id: 'questions-answered', passed: unanswered === 0, detail: `${initialQuestions} questions, ${Object.keys(answers).length} answers` },
    ];
    return {
      index, projectId: project.id, runId: run.id, status: run.status, mode: run.mode,
      sourceRevision: run.sourceRevision, specRevision: run.specRevision, planRevision: run.planRevision,
      specVersion: run.specVersion, planVersion: run.planVersion,
      requirements: run.spec.requirements.length, tasks: run.tasks.length,
      questions: { initial: initialQuestions, answered: Object.keys(answers).length, unanswered },
      modelCalls, artifacts, documents, planProjectionHash: jsonHash(projection),
      zip: { path: zipPath, bytes: zip.length, sha256: sha256(zip), entries: [...entries.keys()].sort() },
      checks, passed: checks.every(check => check.passed),
    };
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function runAcceptance({ fixturePath, outDir, repetitions = 2, archiveFile = null, executable = process.env.EXECUTION_SANDBOX_EXE, timeoutMs = 120_000, logger = () => {} } = {}) {
  if (typeof fixturePath !== 'string' || typeof outDir !== 'string' || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('验收参数无效。');
  const fixture = path.resolve(fixturePath), target = path.resolve(outDir), content = await readFile(fixture, 'utf8');
  if (!content.trim()) throw new Error('验收需求文件为空。');
  await mkdir(target, { recursive: true });
  const runs = [];
  for (let index = 1; index <= repetitions; index++) {
    logger(`规划验收 ${index}/${repetitions}：${path.basename(fixture)}`);
    const result = await runOnce({ fixturePath: fixture, content, index, outDir: target, timeoutMs });
    runs.push(result);
  }
  const first = runs[0];
  const documentsEqual = runs.every(run => JSON.stringify(run.documents) === JSON.stringify(first.documents));
  const projectionEqual = runs.every(run => run.planProjectionHash === first.planProjectionHash);
  const runsPassed = runs.every(run => run.passed);
  const planningChecks = [
    ...runs.flatMap(run => run.checks.map(check => ({ ...check, id: `run-${run.index}-${check.id}` }))),
    { id: 'deterministic-documents', passed: documentsEqual, detail: documentsEqual ? 'same hashes' : 'hashes differ' },
    { id: 'deterministic-plan', passed: projectionEqual, detail: projectionEqual ? 'same projection hash' : 'projection differs' },
  ];
  const planning = {
    passed: runsPassed && documentsEqual && projectionEqual,
    reproducible: documentsEqual && projectionEqual,
    modelCalls: runs.reduce((total, run) => total + run.modelCalls, 0),
    runs, checks: planningChecks,
  };
  let webDelivery = { status: 'not_provided', passed: false, reason: '未提供 --archive；规划验收已完成，固定参考Web交付未复核。' };
  if (archiveFile) {
    logger('固定参考Web交付复验：不调用模型');
    try {
      const archive = path.resolve(archiveFile);
      const report = await revalidateWebArchive({ archiveFile: archive, outputDir: path.join(target, 'web-delivery'), executable, timeoutMs: 120_000 });
      webDelivery = {
        status: report.status, passed: report.status === 'checks_passed', archiveHash: report.archiveHash,
        http: { passed: report.test?.checks?.filter(check => check.passed).length ?? 0, total: report.test?.checks?.length ?? 0 },
        browser: { passed: report.browser?.checks?.filter(check => check.passed).length ?? 0, total: report.browser?.checks?.length ?? 0 },
        reportPath: report.reportPath,
        notice: '此结果仅重新执行固定HTTP/数据库和Edge检查，不调用模型、不把包内历史Review当成新的通过结论。',
      };
    } catch (error) {
      webDelivery = { status: 'failed', passed: false, reason: error instanceof Error ? error.message : '固定参考Web交付复验失败。' };
    }
  }
  const status = !planning.passed ? 'failed' : !archiveFile ? 'planning_passed_only' : webDelivery.passed ? 'passed' : 'failed';
  const report = {
    format: 'taskflow-acceptance-v1', generatedAt: new Date().toISOString(), status, complete: status === 'passed',
    environment: { node: process.version, platform: process.platform, commit: gitCommit() },
    fixture: { path: fixture, bytes: Buffer.byteLength(content), sha256: sha256(content) },
    planning, webDelivery,
  };
  const jsonPath = path.join(target, 'acceptance.json'), markdownPath = path.join(target, 'acceptance.md');
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  const checkRows = [...planningChecks, ...(archiveFile ? [{ id: 'web-delivery', passed: webDelivery.passed, detail: webDelivery.status }] : [])];
  await writeFile(markdownPath, `# Taskflow 可复现验收报告\n\n- 生成时间：${report.generatedAt}\n- 代码提交：${report.environment.commit || '未知'}\n- Node.js：${report.environment.node}\n- 需求文件：${report.fixture.path}（${report.fixture.bytes} bytes，SHA256 ${report.fixture.sha256}）\n- 规划模式：local（不调用模型）\n- 重复次数：${repetitions}\n\n## 结果\n\n- 规划验收：${planning.passed ? '通过' : '未通过'}\n- 可复现：${planning.reproducible ? '是（文档和计划投影一致）' : '否'}\n- 模型调用：${planning.modelCalls}\n- 固定参考Web交付：${webDelivery.status}${webDelivery.passed ? '（通过）' : ''}\n- 总状态：${status}\n\n## 检查项\n\n${checkRows.map(check => `- [${check.passed ? 'x' : ' '}] ${check.id}：${check.detail}`).join('\n')}\n\n## 运行记录\n\n${runs.map(run => `- 第${run.index}次：需求 ${run.requirements} 条，任务 ${run.tasks} 条，规格 ${run.specRevision.slice(0, 12)}，计划 ${run.planRevision.slice(0, 12)}，文档包 ${run.zip.sha256.slice(0, 12)}`).join('\n')}\n\n## 说明\n\n规划验收使用固定示例和本地规则模式，自动填写示例中的待确认问题并自动确认规格/计划，仅用于可复现流程验证，不替代业务审阅或人工验收。固定参考Web交付复验依赖本机MXC与Edge，不调用模型，也不把包内历史Review当作新的通过结论。\n`);
  return { ...report, reportPath: jsonPath, markdownPath };
}
