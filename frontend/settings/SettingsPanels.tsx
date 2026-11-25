import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Bot, Plug } from 'lucide-react';
import { requestStartupReadiness } from './api';
import type { Provider, Snapshot, StartupReadiness } from './api';

export type SettingsView = 'api' | 'agents';

const navigation = [
  { label: 'API 服务', href: '/api-settings.html', view: 'api', Icon: Plug },
  { label: 'Agent 角色', href: '/agent-settings.html', view: 'agents', Icon: Bot },
];

export function SettingsNavigation({ view }: { view: SettingsView }) {
  return (
    <header className="settings-header">
      <div className="settings-header-inner">
        <a className="settings-brand" href="/" aria-label="Taskflow 工作台首页">
          <img src="/taskflow.svg" alt="" width="30" height="30" />
          <strong>Taskflow</strong>
        </a>
        <nav className="settings-navigation" aria-label="设置导航">
          {navigation.map(({ href, label, view: itemView, Icon }) => (
            <a key={href} href={href} aria-current={itemView === view ? 'page' : undefined}>
              <Icon aria-hidden="true" size={16} />{label}
            </a>
          ))}
        </nav>
        <a className="settings-back" href="/"><ArrowLeft aria-hidden="true" size={15} />项目工作台</a>
      </div>
    </header>
  );
}

function StartupReadinessStatus({ snapshot }: { snapshot: Snapshot }) {
  const [observation, setObservation] = useState<{ snapshot: Snapshot; state: StartupReadiness }>();
  useEffect(() => {
    const controller = new AbortController();
    void requestStartupReadiness(controller.signal).then(state => {
      if (!controller.signal.aborted) setObservation({ snapshot, state });
    });
    return () => controller.abort();
  }, [snapshot]);

  const state = observation?.snapshot === snapshot ? observation.state : undefined;
  const title = !state ? '正在核对' : {
    ready: '启动前置已满足',
    blocked: '启动受阻',
    unavailable: '当前未开放',
    unknown: '状态未核对',
  }[state.kind];
  const reason = state?.kind === 'blocked'
    ? state.reason ?? '请在项目工作台查看启动条件。'
    : state?.kind === 'unavailable' ? state.reason
      : state?.kind === 'unknown' ? '可重新载入配置以核对当前服务状态。' : undefined;

  return (
    <section className="settings-start-readiness" aria-labelledby="settings-startup-heading">
      <h3 id="settings-startup-heading">自动交付就绪状态</h3>
      <p id="settings-startup-status" data-state={state?.kind ?? 'loading'} aria-live="polite">
        <strong>{title}</strong>
        {reason && <span>{reason}</span>}
      </p>
      <small>配置就绪后，在项目工作台确认模型用量再启动。</small>
    </section>
  );
}

export function SettingsOverview({ snapshot, view }: { snapshot: Snapshot; view: SettingsView }) {
  const totalRoles = snapshot.roleDefinitions.length;
  const defaultRoles = Object.values(snapshot.roles).filter(provider => provider === 'env').length;
  const servicesWithKey = snapshot.providers.filter(provider => provider.hasKey).length;

  return (
    <aside className="settings-overview" aria-label="当前配置概览">
      <h2>当前配置</h2>
      <dl>
        <div className="settings-environment">
          <dt>环境默认</dt>
          <dd>
            <span className="settings-status-dot" data-configured={snapshot.environment.configured} aria-hidden="true" />
            <strong id="environment-status">{snapshot.environment.configured ? snapshot.environment.model : '尚未配置'}</strong>
          </dd>
        </div>
        <div className="settings-overview-stat">
          <dt>{view === 'api' ? '已设置密钥的服务' : '可分配的 API 服务'}</dt>
          <dd>{view === 'api' ? <>{servicesWithKey}<span> / {snapshot.providers.length}</span></> : snapshot.providers.length}</dd>
        </div>
        <div className="settings-overview-stat">
          <dt>已绑定 API 服务的角色</dt>
          <dd>{totalRoles - defaultRoles}<span> / {totalRoles}</span></dd>
        </div>
      </dl>
      <StartupReadinessStatus snapshot={snapshot} />
      {view === 'api' ? (
        <>
          <p>远程服务需要密钥。localhost 与 127.0.0.1 服务可留空。</p>
          <a className="settings-inline-link" href="/agent-settings.html">分配角色<ArrowUpRight size={15} aria-hidden="true" /></a>
        </>
      ) : (
        <>
          <p>开发执行沿用启动时配置。规划在每次新调用时读取配置。</p>
          <a className="settings-inline-link" href="/api-settings.html">管理 API 服务<ArrowUpRight size={15} aria-hidden="true" /></a>
        </>
      )}
    </aside>
  );
}

function savedRoleBinding(snapshot: Snapshot, roleId: string) {
  const providerId = snapshot.roles[roleId];
  if (providerId === 'env') {
    return snapshot.environment.configured
      ? { name: '环境默认', model: snapshot.environment.model, status: 'configured' }
      : { name: '环境默认', model: '尚未配置环境模型', status: 'blocked' };
  }

  const provider = snapshot.providers.find(item => item.id === providerId);
  if (provider) return { name: provider.name, model: provider.model, status: 'configured' };
  return providerId
    ? { name: '绑定服务不可用', model: '请选择其他服务', status: 'blocked' }
    : { name: '映射未核对', model: '重新载入配置后核对', status: 'unknown' };
}

interface RoleProps {
  snapshot: Snapshot;
  roles: Snapshot['roles'];
  dirty: boolean;
  busy: boolean;
  saving: boolean;
  onChange: (role: string, value: string) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
}

export function RolesPanel({ snapshot, roles, dirty, busy, saving, onChange, onSave }: RoleProps) {
  return (
    <form id="agent-settings-form" className="settings-paper" onSubmit={onSave}>
      <div className="settings-paper-heading">
        <h2>角色分工与服务映射</h2>
      </div>
      <fieldset id="agent-settings-fields" className="settings-fields" disabled={busy}>
        <legend className="settings-visually-hidden">选择各 Agent 调用的 API 服务</legend>
        <div className="settings-role-columns settings-table-head" aria-hidden="true">
          <span>角色</span><span>职责</span><span>已应用</span><span>调整服务</span>
        </div>
        <div id="agent-role-bindings">
          {snapshot.roleDefinitions.map(role => {
            const applied = savedRoleBinding(snapshot, role.id);
            return (
              <div className="settings-role" key={role.id}>
                <label htmlFor={`agent-role-${role.id}`}>{role.label}</label>
                <p className="settings-role-description" id={`agent-role-description-${role.id}`}>{role.description}</p>
                <p className="settings-role-applied" data-status={applied.status}><span className="settings-mobile-label">已应用</span>
                  <strong>{applied.name}</strong>
                  <small>{applied.model}</small>
                </p>
                <select id={`agent-role-${role.id}`} data-agent-role={role.id} data-changed={roles[role.id] !== snapshot.roles[role.id]} aria-describedby={`agent-role-description-${role.id}`} value={roles[role.id] ?? 'env'} onChange={event => onChange(role.id, event.currentTarget.value)}>
                  <option value="env">{snapshot.environment.configured ? `环境默认 / ${snapshot.environment.model}` : '环境默认（尚未配置）'}</option>
                  {snapshot.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} / {provider.model}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </fieldset>
      <footer className="settings-save">
        <p id="agent-settings-save-state" data-dirty={dirty}>{dirty ? '有未保存的角色分配' : `已应用配置版本 ${snapshot.revision}`}</p>
        <button id="save-agent-settings" type="submit" className="settings-button settings-primary" disabled={busy}>{saving ? '正在保存…' : '保存并应用'}</button>
      </footer>
    </form>
  );
}

interface ServiceProps {
  snapshot: Snapshot;
  busy: boolean;
  rowErrors: Record<string, string>;
  onEdit: (provider: Provider, trigger: HTMLElement) => void;
  onDelete: (provider: Provider) => void;
}

function ServiceRow({ provider, assignments, busy, error, onEdit, onDelete }: {
  provider: Provider;
  assignments: number;
  busy: boolean;
  error: string;
  onEdit: ServiceProps['onEdit'];
  onDelete: ServiceProps['onDelete'];
}) {
  const errorRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  return (
    <div className="settings-provider-row" data-provider-id={provider.id}>
      <div className="settings-provider-name">
        <strong>{provider.name}</strong>
        <p>{provider.baseUrl}</p>
      </div>
      <div className="settings-provider-model">
        <span className="settings-mobile-label">模型</span>{provider.model}
      </div>
      <div className="settings-provider-usage">
        <span className="settings-key-status" data-configured={provider.hasKey}>
          <span className="settings-status-dot" data-configured={provider.hasKey} aria-hidden="true" />
          {provider.hasKey ? '密钥已设置' : '密钥未设置'}
        </span>
        <small>{assignments ? `${assignments} 个角色使用` : '尚未分配角色'}</small>
      </div>
      <div className="settings-provider-actions">
        <button type="button" data-edit-provider="" aria-label={`编辑 ${provider.name}`} disabled={busy} onClick={event => onEdit(provider, event.currentTarget)}>编辑</button>
        <button type="button" data-delete-provider="" aria-label={`删除 ${provider.name}`} disabled={busy} onClick={() => onDelete(provider)}>删除</button>
      </div>
      <p ref={errorRef} className="settings-message settings-error settings-provider-error" data-provider-error="" role="alert" hidden={!error}>{error}</p>
    </div>
  );
}

export function ServicesPanel({ snapshot, busy, rowErrors, onEdit, onDelete }: ServiceProps) {
  const assignments = Object.values(snapshot.roles);
  return (
    <section id="api-services-section" className="settings-paper" aria-labelledby="providers-heading">
      <div className="settings-paper-heading">
        <h2 id="providers-heading">已配置的服务 <span id="provider-count" className="settings-count">{snapshot.providers.length}</span></h2>
      </div>
      <p id="agent-providers-empty" className="settings-empty" hidden={snapshot.providers.length > 0}>还没有 API 服务。添加服务后可为 Agent 分配模型。</p>
      {snapshot.providers.length > 0 && <div className="settings-provider-columns settings-table-head" aria-hidden="true">
        <span>服务 / 地址</span><span>模型</span><span>凭据与使用情况</span><span>操作</span>
      </div>}
      <div id="agent-providers" className="settings-provider-list">
        {snapshot.providers.map(provider => <ServiceRow
          key={provider.id}
          provider={provider}
          assignments={assignments.filter(id => id === provider.id).length}
          busy={busy}
          error={rowErrors[provider.id] ?? ''}
          onEdit={onEdit}
          onDelete={onDelete}
        />)}
      </div>
    </section>
  );
}
