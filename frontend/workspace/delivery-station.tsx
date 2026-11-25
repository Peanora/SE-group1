import { ArrowRight, CheckCircle2, ClipboardCheck, Code2, FlaskConical, GitFork, Layers3, PackageCheck } from 'lucide-react';
import { Button } from '../components/button';

export const deliverySurfaces = [
  { id: 'overview', label: '交付总览', icon: Layers3 },
  { id: 'checklist', label: '验收清单', icon: ClipboardCheck },
  { id: 'candidates', label: '候选与证据', icon: Code2 },
  { id: 'releases', label: '本机版本', icon: GitFork },
  { id: 'reference', label: '参考实验', icon: FlaskConical },
] as const;

export function DeliveryStationTabs() {
  return (
    <nav id="delivery-station-tabs" className="delivery-station-tabs" role="tablist" aria-label="交付工作面">
      {deliverySurfaces.map(({ id, label, icon: Icon }, index) => (
        <button key={id} type="button" role="tab" id={'delivery-tab-' + id}
          data-delivery-surface={id} aria-controls={'delivery-pane-' + id} aria-selected={index === 0}
          tabIndex={index === 0 ? 0 : -1}>
          <Icon aria-hidden="true" />{label}
        </button>
      ))}
    </nav>
  );
}

interface Version {
  kind: string;
  reference: string;
  status: string;
}
interface Detail {
  label: string;
  value: string;
}

export interface DeliveryOverviewProps {
  state: string;
  status: string;
  title: string;
  note: string;
  action: { label: string; stage: string } | null;
  versions: Version[];
  evidence: Detail[];
  busy: boolean;
}

export function DeliveryOverview({ state, status, title, note, action, versions, evidence, busy }: DeliveryOverviewProps) {
  return (
    <div className="delivery-instrument">
      <section className="delivery-present" aria-labelledby="delivery-now-title">
        <header className="delivery-paper-bar">
          <span><PackageCheck aria-hidden="true" />当前交付</span>
          <span className="delivery-now-status" data-state={state} role="status">{status}</span>
        </header>
        <div className="delivery-decision">
          <div>
            <h3 id="delivery-now-title">{title}</h3>
            <p>{note}</p>
          </div>
          {action && (
            <Button type="button" data-delivery-jump={action.stage} disabled={busy}>
              {action.label}<ArrowRight aria-hidden="true" />
            </Button>
          )}
        </div>
        <section className="delivery-evidence-summary" aria-label="检查概览">
          <h4><CheckCircle2 aria-hidden="true" />本次检查证据</h4>
          <dl>
            {evidence.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
          </dl>
        </section>
      </section>
      <aside className="delivery-chain" aria-label="运行版本链">
        <h4>版本链</h4>
        <ol>
          {versions.map(version => (
            <li key={version.kind}>
              <span aria-hidden="true" />
              <div>
                <strong>{version.kind}</strong>
                <small>{version.status}</small>
                {version.reference && <code title={version.reference}>{version.reference.slice(0, 12)}</code>}
              </div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
