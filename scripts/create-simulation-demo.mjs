import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { simulationPlanner } from '../examples/simulation-fixture.mjs';

// Separate local demo data. Never writes to the user's default data directory.
const dataDir = path.resolve('output/simulation-demo-data');
const app = await createApp({ dataDir, stepDelayMs: 0, planner: simulationPlanner, executionService: null, sourceChangeService: null });
try {
  const project = await app.store.create({ name: '模拟编排 A-B/C-D-E', source: { filename: 'simulation-demo.md',
    content: 'A完成后B和C并行；二者完成后D等待人工确认，确认后E启动。本例仅模拟执行。' } });
  const run = await app.orchestrator.createRun(project.id, { mode: 'local' });
  const wait = async status => { for (let i = 0; i < 500; i++) { if (run.status === status) return; await delay(10); } throw new Error(`演示准备未到达${status}`); };
  await wait('awaiting_spec');
  await app.orchestrator.action(project.id, run.id, { action: 'approve_spec', revision: run.specRevision, feedback: '演示脚本确认固定示例规格；非真实业务审批。' });
  await wait('awaiting_review');
  console.log(`已创建独立演示数据：${dataDir}\n计划尚未确认，请在页面人工核对并确认。\n项目：${project.id}\n规划：${run.id}\n使用DATA_DIR=output/simulation-demo-data、PORT=4320运行npm start。`);
} finally { await app.close(); }
