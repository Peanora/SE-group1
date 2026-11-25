import path from 'node:path';
import { mkdtemp, readFile, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import { loadEnv } from '../server.mjs';
import { revalidatePlannedArchive } from '../lib/planned-archive.mjs';

const [, , flag, filename, mode, extra] = process.argv;
if (flag !== '--archive' || !filename || extra || (mode !== undefined && !['--cold-start', '--inspect'].includes(mode))) {
  console.error('使用 --archive ZIP路径 [--inspect | --cold-start] 进行免费交付核对或复验。不继承历史Review或软件通过。'); process.exitCode = 2;
} else {
  if (mode !== '--inspect') await loadEnv();
  const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadline = mode === '--cold-start' ? setTimeout(stop, 120000) : null;
  try {
    const archiveFile = path.resolve(filename);
    async function inspect() {
      const { inspectPlannedArchive } = await import('../lib/planned-archive.mjs');
      const stat = await lstat(archiveFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error('归档文件无效');
      return inspectPlannedArchive(await readFile(archiveFile));
    }
    if (mode === '--inspect') {
      const archive = await inspect();
      console.log(JSON.stringify({ status: 'integrity_verified', taskAccepted: false, historicalAcceptanceVerified: false, totalModelCalls: 0,
        archiveHash: archive.archiveHash, candidateCommit: archive.binding.candidateCommit,
        startGuidePresent: archive.startGuidePresent, binding: archive.binding, sourceFiles: archive.files.map(file => file.path),
        verificationReport: archive.verificationReport,
        ...(archive.evolution ? { evolution: archive.evolution, executorPolicyCurrent: archive.executorPolicyCurrent } : {}), notice: archive.notice }, null, 2));
    } else if (mode === '--cold-start') {
      const { runPlannedColdStart } = await import('../lib/planned-cold-start.mjs');
      const archive = await inspect(), rootDir = await mkdtemp(path.join(os.tmpdir(), 'tf-boot-'));
      const report = await runPlannedColdStart({ manifest: archive.manifest, files: archive.files, rootDir, executable: process.env.EXECUTION_SANDBOX_EXE, signal: controller.signal });
      const reportPath = path.join(rootDir, 'cold-start.json');
      const scope = { scope: 'empty_database_cold_start', existingDataVerified: false };
      await writeFile(reportPath, JSON.stringify({ ...report, ...scope, archiveHash: archive.archiveHash, candidateCommit: archive.binding.candidateCommit }, null, 2), { flag: 'wx' });
      console.log(JSON.stringify({ status: report.status, ...scope, taskAccepted: false, totalModelCalls: 0, checked: report.checks.length, passed: report.checks.filter(item => item.passed).length, report: reportPath }, null, 2));
      if (report.status !== 'cold_start_passed') process.exitCode = 1;
    } else {
      const report = await revalidatePlannedArchive({ archiveFile, outputDir: path.resolve(import.meta.dirname, '../output/planned-delivery-checks'), signal: controller.signal });
      console.log(JSON.stringify({ status: report.status, taskAccepted: false, totalModelCalls: 0, terminationConfirmed: report.terminationConfirmed,
        ...(report.evolution ? { integrityVerified: true, historicalAcceptanceVerified: false, evolution: report.evolution, executorPolicyCurrent: report.executorPolicyCurrent, notice: report.notice } : {}),
        http: report.test?.checks?.filter(item => item.passed).length ?? 0, browser: report.browser?.checks?.filter(item => item.passed).length ?? 0, report: report.reportPath }, null, 2));
      if (report.status !== 'checks_passed') process.exitCode = 1;
    }
  } catch { console.error('规划源码包未获得有效复核结论，请检查包版本、规则和隔离环境。'); process.exitCode = 1; }
  finally { clearTimeout(deadline); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
