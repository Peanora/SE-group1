import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server.mjs';
import { runAcceptance } from '../lib/acceptance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback; };

if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法：npm run acceptance -- [选项]

  --fixture <路径>      验收需求文件，默认 examples/library-system.md
  --out <目录>          报告和文档包输出目录，默认 output/acceptance-<时间>
  --repetitions <2>     规划重复次数，1-3，默认2；用来验证同一输入产生相同文档和计划
  --archive <路径>      可选：对固定图书借阅Web源码ZIP重新执行HTTP/数据库和Edge检查
  -h, --help            显示帮助

不调用模型。规划验收使用 local 模式；如需完整Web交付复核，请同时提供 --archive。`);
} else {
  const fixture = path.resolve(root, option('--fixture', 'examples/library-system.md'));
  const outDir = path.resolve(root, option('--out', `output/acceptance-${Date.now()}`));
  const archive = option('--archive', '');
  const repetitions = Number(option('--repetitions', '2'));
  try {
    await loadEnv();
    const report = await runAcceptance({ fixturePath: fixture, outDir, repetitions, archiveFile: archive ? path.resolve(root, archive) : null, logger: message => console.log(`[acceptance] ${message}`) });
    console.log(JSON.stringify({ status: report.status, complete: report.complete, planning: { passed: report.planning.passed, reproducible: report.planning.reproducible, modelCalls: report.planning.modelCalls }, webDelivery: report.webDelivery.status, report: report.reportPath, markdown: report.markdownPath }, null, 2));
    if (report.status === 'planning_passed_only') console.log('[acceptance] 规划验收已通过；未提供 --archive，固定参考Web交付未复核。');
    process.exitCode = report.status === 'failed' ? 1 : 0;
  } catch (error) {
    console.error(`[acceptance] 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
