import { useLayoutEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import type { Provider, Snapshot } from './api';

export type SettingsView = 'api' | 'agents';

const navigation = [
  { label: '项目工作台', href: '/' },
  { label: 'Agent 角色', href: '/agent-settings.html', view: 'agents' },
  { label: 'API 服务', href: '/api-settings.html', view: 'api' },
];

export function SettingsNavigation({ view }: { view: SettingsView }) {
  return (
    <aside className="settings-sidebar" aria-label="工作台导航">
      <a className="settings-brand" href="/" aria-label="Taskflow 工作台首页">
        <img className="settings-brand-mark" src="/taskflow.svg" alt="" width="30" height="30" />
        <strong>Taskflow</strong>
      </a>
      <nav className="settings-navigation">
        {navigation.map(item => (
          <a key={item.href} href={item.href} aria-current={item.view === view ? 'page' : undefined}>{item.label}</a>
        ))}
      </nav>
    </aside>
  );
}

function Environment({ environment }: Pick<Snapshot, 'environment'>) {
  return (
    <div className="settings-environment">
      <span className="settings-status-dot" data-configured={environment.configured} aria-hidden="true" />
      <span>环境默认</span>
      <strong id="environment-status">{environment.configured ? environment.model : '尚未配置'}</strong>
    </div>
  );
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
        <h2>角色分工</h2>
        <a className="settings-inline-link" href="/api-settings.html">管理 API 服务</a>
      </div>
      <Environment environment={snapshot.environment} />
      <fieldset id="agent-settings-fields" className="settings-fields" disabled={busy}>
        <legend className="settings-visually-hidden">选择各 Agent 调用的 API 服务</legend>
        <div className="settings-role-columns settings-table-head" aria-hidden="true">
          <span>角色与职责</span><span>调用服务 / 模型</span>
        </div>
        <div id="agent-role-bindings">
          {snapshot.roleDefinitions.map(role => (
            <div className="settings-role" key={role.id}>
              <div>
                <label htmlFor={`agent-role-${role.id}`}>{role.label}</label>
                <p id={`agent-role-description-${role.id}`}>{role.description}</p>
              </div>
              <select id={`agent-role-${role.id}`} data-agent-role={role.id} aria-describedby={`agent-role-description-${role.id}`} value={roles[role.id] ?? 'env'} onChange={event => onChange(role.id, event.currentTarget.value)}>
                <option value="env">{snapshot.environment.configured ? `环境默认 / ${snapshot.environment.model}` : '环境默认（尚未配置）'}</option>
                {snapshot.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} / {provider.model}</option>)}
              </select>
            </div>
          ))}
        </div>
      </fieldset>
      <footer className="settings-save">
        <div>
          <p id="agent-settings-save-state" data-dirty={dirty}>{dirty ? '有未保存的角色分配' : `已应用配置版本 ${snapshot.revision}`}</p>
          <small>开发执行沿用启动时配置。规划在每次新调用时读取配置。</small>
        </div>
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
        {provider.model}
        <small>{provider.hasKey ? '密钥已设置' : '密钥未设置'} <span aria-hidden="true">·</span> {assignments ? `${assignments} 个角色使用` : '尚未分配角色'}</small>
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
        <a className="settings-inline-link" href="/agent-settings.html">分配角色</a>
      </div>
      <Environment environment={snapshot.environment} />
      <p id="agent-providers-empty" className="settings-empty" hidden={snapshot.providers.length > 0}>还没有 API 服务。添加服务后可为 Agent 分配模型。</p>
      {snapshot.providers.length > 0 && <div className="settings-provider-columns settings-table-head" aria-hidden="true">
        <span>服务 / 地址</span><span>模型 / 使用情况</span><span>操作</span>
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
