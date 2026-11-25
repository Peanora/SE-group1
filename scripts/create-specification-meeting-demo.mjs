import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { reservationMeetingPlanner, reservationMeetingSource } from '../examples/specification-meeting.mjs';

const dataDir = path.resolve('output/specification-meeting-demo-data');
const app = await createApp({ dataDir, stepDelayMs: 0, planner: reservationMeetingPlanner });
try {
  const project = await app.store.create({ name: '多 Agent 预约规格评审', source: { filename: 'reservation.md', content: reservationMeetingSource } });
  const run = await app.orchestrator.createRun(project.id);
  for (let i = 0; i < 1000 && run.status !== 'awaiting_spec'; i++) await delay(5);
  if (run.status !== 'awaiting_spec') throw new Error('演示未到达规格确认停点。');
  console.log(`已创建独立离线演示数据：${dataDir}\n项目：${project.id}\n未确认规格、未调用模型、未启动编码。\n设置DATA_DIR=output/specification-meeting-demo-data及PORT=4321，然后npm start。\n页面点击“启用本版离线评审”。`);
} finally { await app.close(); }
