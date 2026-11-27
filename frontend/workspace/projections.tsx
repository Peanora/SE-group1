import { DeliveryOverview, type DeliveryOverviewProps } from './delivery-station';
import {
  BadgeCheck, Box, Braces, Check, ClipboardCheck, FileText, ListChecks, Map as MapIcon, Scan, ScrollText,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

const roots = new WeakMap<Element, Root>();

function render(container: Element, content: ReactNode) {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  const target = root;
  flushSync(() => target.render(content));
}

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  label: string;
  runCount: number;
}

export function showProjects(container: Element, projects: ProjectRow[], activeId: string | undefined) {
  render(container, projects.length ? projects.map(project => {
    const active = project.id === activeId;
    return (
      <div key={project.id} className="project-row">
        <button type="button" className={active ? 'project-item active' : 'project-item'} data-project={project.id}
          aria-current={active ? 'page' : undefined}>
          <FileText className="project-icon" aria-hidden="true" />
          <span className="project-info">
            <span className="project-name">{project.name}</span>
            <span className="project-meta">{project.label} / {project.runCount} 次运行</span>
          </span>
          <span className={'project-state-dot ' + project.status} aria-hidden="true" />
        </button>
        <button type="button" className="project-delete" data-delete-project={project.id}
          aria-label={'删除项目：' + project.name} title="删除项目">×</button>
      </div>
    );
  }) : <div className="empty-projects">尚无项目</div>);
}

interface Phase {
  id: string;
  title: string;
  state: string;
  text: string;
  detail?: string;
  hasUsage?: boolean;
}

const workflowPhases = [
  { id: 'requirements', title: '需求与规格', steps: ['source', 'spec', 'spec-approval'] },
  { id: 'planning', title: '工程规划', steps: ['plan', 'plan-approval'] },
  { id: 'delivery', title: '开发与验收', steps: ['verification', 'coding', 'testing', 'delivery'] },
] as const;

const phaseIcons = {
  source: FileText,
  spec: ScrollText,
  'spec-approval': BadgeCheck,
  plan: MapIcon,
  'plan-approval': ClipboardCheck,
  verification: ListChecks,
  coding: Braces,
  testing: Scan,
  delivery: Box,
};

export function showRunTimeline(container: Element, steps: Phase[], currentId: string | undefined,
  pending: boolean, hasProject: boolean) {
  const byId = new Map(steps.filter(step => step.state !== 'unavailable').map(step => [step.id, step]));
  render(container, workflowPhases.map(phase => (
    phase.steps.some(id => byId.has(id)) && <li key={phase.id} className="studio-lane" data-phase={phase.id}>
      <h2 id={'studio-lane-' + phase.id}>{phase.title}</h2>
      <ol className="studio-lane-steps" aria-labelledby={'studio-lane-' + phase.id}>
        {phase.steps.map(id => {
          const step = byId.get(id);
          if (!step) return null;
          const Icon = phaseIcons[id];
          return (
            <li key={id} className="studio-route-stop" data-state={step.state}>
              <button type="button" className="studio-step" data-delivery-step={id}
                data-state={step.state} data-has-usage={step.hasUsage ? '' : undefined}
                aria-current={id === currentId ? 'step' : undefined}
                disabled={pending || (!hasProject && id !== 'source')}
                title={[step.title, step.text, step.detail].filter(Boolean).join(' · ')}>
                <span className="studio-step-icon" aria-hidden="true"><Icon size={17} /></span>
                <strong>{step.title}</strong>
                <span className="delivery-state"><span className="studio-step-dot" aria-hidden="true">
                  {step.state === 'done' && <Check size={9} strokeWidth={3} />}
                </span>{step.text}</span>
                {step.detail && <small>{step.detail}</small>}
              </button>
            </li>
          );
        })}
      </ol>
    </li>
  )));
}

export function showExecutionTimeline(container: Element, steps: Phase[], currentId: string, disabled: boolean) {
  render(container, steps.map((step, index) => (
    <li key={step.id}>
      <button type="button" className="execution-workspace-step" data-execution-step={step.id} data-state={step.state}
        aria-current={step.id === currentId ? 'step' : undefined} disabled={disabled || step.state === 'unavailable'}>
        <span className="execution-step-marker" aria-hidden="true">
          {step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : index + 1}
        </span>
        <span className="execution-step-label"><strong>{step.title}</strong><small>{step.text}</small></span>
      </button>
    </li>
  )));
}
interface HistoryRow {
  id: string;
  status: string;
  time: string;
  dateTime: string;
  order: number;
  revision: string;
}

export function showRunHistory(container: Element, rows: HistoryRow[], activeId: string | undefined) {
  render(container, rows.map(row => (
    <li key={row.id}>
      <button type="button" data-run-history-id={row.id} aria-current={row.id === activeId ? 'true' : undefined}>
        <strong>运行 {String(row.order).padStart(2, '0')}</strong>
        <time dateTime={row.dateTime}>{row.time}</time>
        <small>{row.status}{row.revision ? ' · ' + row.revision : ''}</small>
      </button>
    </li>
  )));
}

export function showDeliveryOverview(container: Element, props: DeliveryOverviewProps) {
  render(container, <DeliveryOverview {...props} />);
}
