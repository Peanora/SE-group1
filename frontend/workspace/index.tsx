import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { installTaskCanvas } from '../canvas/task-canvas';
import { Workspace } from './workspace';
import './foundation.css';
import '../../public/styles.css';
import '../../public/workspace.css';
import '../../public/workbench-theme.css';
import '../../public/source-process.css';
import '../../public/execution-process.css';
import '../../public/task-orchestration.css';
import './workbench.css';
import '../canvas/task-navigator.css';
import './task-schedule.css';
import './design-review.css';
import './specification-meeting.css';
import './delivery-station.css';
import './fixed-reference.css';
import './local-delivery.css';
import './flow-workspace.css';

const container = document.getElementById('root');
if (!container) throw new Error('未找到项目工作台入口。');

container.inert = true;
container.setAttribute('aria-busy', 'true');
installTaskCanvas();
const root = createRoot(container);
flushSync(() => root.render(<Workspace />));
void import('./controller.js').catch(error => {
  console.error('工作台初始化失败', error);
  const connection = document.getElementById('connection-status');
  if (connection) connection.textContent = '工作台加载失败，请刷新页面重试';
}).finally(() => {
  container.inert = false;
  container.removeAttribute('aria-busy');
});
