import { ArrowRight, ClipboardCheck, Code2, FlaskConical, GitCommitHorizontal, GitFork, Layers3, ListChecks, PackageCheck } from 'lucide-react';
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
    <div className="studio-delivery-overview">
      <section className="studio-delivery-decision" aria-labelledby="delivery-now-title">
        <PackageCheck aria-hidden="true" />
        <div>
          <span className="studio-decision-status" data-state={state} role="status">{status}</span>
          <h3 id="delivery-now-title">{title}</h3>
          <p>{note}</p>
        </div>
        {action && (
          <Button type="button" data-delivery-jump={action.stage} disabled={busy}>
            {action.label}<ArrowRight aria-hidden="true" />
          </Button>
        )}
      </section>
      <div className="studio-delivery-evidence">
        <section aria-label="检查概览">
          <h4><ListChecks aria-hidden="true" />候选验收证据</h4>
          <dl className="studio-checks-list">
            {evidence.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
          </dl>
        </section>
        <aside aria-label="运行版本链">
          <h4><GitCommitHorizontal aria-hidden="true" />本次运行的版本</h4>
          <table className="studio-version-table">
            <thead><tr><th scope="col">产物</th><th scope="col">状态</th><th scope="col">版本</th></tr></thead>
            <tbody>{versions.map(version => (
              <tr key={version.kind}>
                <th scope="row">{version.kind}</th>
                <td>{version.status}</td>
                <td>{version.reference ? <code title={version.reference}>{version.reference.slice(0, 12)}</code> : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </aside>
      </div>
    </div>
  );
}
