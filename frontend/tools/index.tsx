import { createRoot } from 'react-dom/client';
import { FactoryPage } from './factory';
import { TeamPage } from './team';
import './tools.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(document.body.dataset.taskflowTool === 'factory' ? <FactoryPage /> : <TeamPage />);
}
