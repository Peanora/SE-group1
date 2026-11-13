import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server.mjs';
import { revalidateWebArchive } from '../lib/web-archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 4 || process.argv[2] !== '--archive') {
  console.error('使用 --archive 路径 复验已有交付ZIP；不调用模型，不相信包内的npm test或通过声明。');
  process.exitCode = 2;
} else {
  await loadEnv();
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const report = await revalidateWebArchive({ archiveFile: path.resolve(process.argv[3]), outputDir: path.join(root, 'output', 'delivery-verification'), signal: controller.signal });
    console.log(JSON.stringify({ status: report.status, taskAccepted: false, historicalAcceptanceVerified: false,
      archiveHash: report.archiveHash, sourceHash: report.binding.sourceHash,
      http: { passed: report.test?.checks?.filter(check => check.passed).length ?? 0, total: report.test?.checks?.length ?? 0 },
      browser: { passed: report.browser?.checks?.filter(check => check.passed).length ?? 0, total: report.browser?.checks?.length ?? 0 },
      report: report.reportPath, notice: '此结果仅为本次重新执行检查；包内历史Review和完成声明不作为可信结论。' }, null, 2));
    if (report.status !== 'checks_passed') process.exitCode = 1;
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : '交付复验失败。'); process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
