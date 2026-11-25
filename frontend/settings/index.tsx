import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, RefreshCw } from 'lucide-react';
import { providerFields, requestSettings } from './api';
import type { Provider, ProviderInput, Snapshot } from './api';
import { ProviderDrawer } from './ProviderDrawer';
import type { Editor } from './ProviderDrawer';
import { RolesPanel, ServicesPanel, SettingsNavigation, SettingsOverview } from './SettingsPanels';
import type { SettingsView } from './SettingsPanels';
import './settings.css';

type Phase = 'idle' | 'loading' | 'saving';

function Settings({ view }: { view: SettingsView }) {
  const isServicePage = view === 'api';
  const title = isServicePage ? 'API 服务' : 'Agent 角色';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [roles, setRoles] = useState<Snapshot['roles']>({});
  const [phase, setPhase] = useState<Phase>('loading');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [notice, setNotice] = useState('正在读取配置…');
  const [error, setError] = useState('');
  const [providerError, setProviderError] = useState('');
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const activeRequest = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const addProviderRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const navigationApproved = useRef(false);
  const busy = phase !== 'idle';
  const saving = phase === 'saving';
  const rolesDirty = snapshot !== null && Object.keys(roles).some(role => roles[role] !== snapshot.roles[role]);
  const hasDraft = rolesDirty || editorDirty;

  function accept(next: Snapshot) {
    setSnapshot(next);
    setRoles(next.roles);
    setRowErrors({});
  }

  async function perform(
    requestPhase: Exclude<Phase, 'idle'>,
    action: () => Promise<Snapshot>,
    onSuccess: () => void,
    onFailure: (message: string) => void,
  ) {
    if (activeRequest.current) return;
    activeRequest.current = true;
    setPhase(requestPhase);
    try {
      accept(await action());
      onSuccess();
    } catch (failure) {
      onFailure(failure instanceof Error ? failure.message : String(failure));
    } finally {
      activeRequest.current = false;
      setPhase('idle');
    }
  }

  function load() {
    setError('');
    setNotice('正在读取配置…');
    return perform('loading', () => requestSettings(), () => setNotice(''), message => {
      setError(message);
      setNotice('');
    });
  }

  function save(providers: ProviderInput[], assignments: Snapshot['roles'], onSuccess: () => void, onFailure: (message: string) => void) {
    if (!snapshot) return;
    const revision = snapshot.revision;
    setNotice('');
    return perform('saving', () => requestSettings({ revision, providers, roles: assignments }), onSuccess, onFailure);
  }

  useEffect(() => { void load(); }, []);

  useLayoutEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  useLayoutEffect(() => {
    if (busy || editor || !returnFocus.current) return;
    const target = returnFocus.current.isConnected ? returnFocus.current : addProviderRef.current;
    target?.focus({ preventScroll: true });
    returnFocus.current = null;
  }, [busy, editor]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!navigationApproved.current && (hasDraft || saving)) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [hasDraft, saving]);

  useEffect(() => {
    function pageHide() {
      const key = dialogRef.current?.querySelector<HTMLInputElement>('#provider-key');
      if (key) key.value = '';
    }
    function pageShow() { navigationApproved.current = false; }
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    return () => {
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
    };
  }, []);

  function confirmNavigation(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !(hasDraft || saving)) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download') || link.getAttribute('href')?.startsWith('#')) return;
    const question = saving ? '配置正在保存，离开后需重新核对保存结果。是否离开？' : '当前修改尚未保存。是否放弃修改并离开？';
    if (!window.confirm(question)) event.preventDefault();
    else navigationApproved.current = true;
  }

  function reload() {
    if (busy || (hasDraft && !window.confirm('重新载入会替换尚未保存的修改。是否继续？'))) return;
    void load();
  }

  function saveRoles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || busy) return;
    setError('');
    void save(snapshot.providers.map(providerFields), roles,
      () => setNotice('角色分配已保存并应用。后续调用将使用所选服务。'), setError);
  }

  function openProvider(provider: Provider | undefined, trigger: HTMLElement) {
    if (!snapshot || busy) return;
    if (!provider && snapshot.providers.length >= 30) {
      setError('最多添加 30 个 API 服务。');
      return;
    }
    setError('');
    setNotice('');
    setProviderError('');
    setEditorDirty(false);
    returnFocus.current = trigger;
    setEditor({ id: provider?.id ?? crypto.randomUUID(), provider });
  }

  function closeProvider() {
    const dialog = dialogRef.current;
    const key = dialog?.querySelector<HTMLInputElement>('#provider-key');
    if (key) key.value = '';
    if (dialog?.open) dialog.close();
    setEditor(null);
    setEditorDirty(false);
    setProviderError('');
  }

  function saveProvider(provider: ProviderInput) {
    if (!snapshot || !editor || busy) return;
    const providers = snapshot.providers.map(item => item.id === provider.id ? provider : providerFields(item));
    if (!editor.provider) providers.push(provider);
    setProviderError('');
    void save(providers, snapshot.roles, () => {
      closeProvider();
      setNotice('API 服务已保存并应用，可在 Agent 角色页分配使用。');
    }, setProviderError);
  }

  function deleteProvider(provider: Provider) {
    if (!snapshot || busy) return;
    function showRowError(message: string) {
      setRowErrors(current => ({ ...current, [provider.id]: message }));
    }

    showRowError('');
    const assigned = snapshot.roleDefinitions.filter(role => snapshot.roles[role.id] === provider.id);
    if (assigned.length > 0) {
      showRowError(`此服务仍用于${assigned.map(role => role.label).join('、')}。请先在「Agent 角色」更换服务并保存，再删除。`);
      return;
    }
    if (!window.confirm(`删除 API 服务「${provider.name}」？已保存的地址、模型和访问密钥也会删除。`)) return;
    setError('');
    const remaining = snapshot.providers.filter(item => item.id !== provider.id).map(providerFields);
    void save(remaining, snapshot.roles, () => {
      returnFocus.current = addProviderRef.current;
      setNotice('API 服务已删除。');
    }, showRowError);
  }

  return (
    <div className="settings-layout" onClickCapture={confirmNavigation}>
      <a className="settings-skip" href="#agent-settings-main">跳到 {title}</a>
      <SettingsNavigation view={view} />
      <main id="agent-settings-main" className="settings-main" tabIndex={-1}>
        <header className="settings-heading">
          <div>
            <h1>{title}</h1>
            <p>{isServicePage ? '管理模型地址、访问密钥与单价。' : '查看当前分工，为各研发角色调整模型服务。'}</p>
          </div>
          <div className="settings-heading-actions">
            <button id="reload-agent-settings" type="button" className="settings-button settings-reload" onClick={reload} disabled={busy}>
              <RefreshCw size={15} aria-hidden="true" />重新载入配置
            </button>
            {isServicePage && <button ref={addProviderRef} id="add-agent-provider" type="button" className="settings-button settings-primary" disabled={busy || !snapshot} onClick={event => openProvider(undefined, event.currentTarget)}>
              <Plus size={16} aria-hidden="true" />添加服务
            </button>}
          </div>
        </header>
        <p ref={errorRef} id="agent-settings-error" className="settings-message settings-error" role="alert" hidden={!error}>{error}</p>
        <p id="agent-settings-notice" className="settings-message" role="status" hidden={!notice}>{notice}</p>
        {snapshot && <div className="settings-content">
          {isServicePage
            ? <ServicesPanel snapshot={snapshot} busy={busy} rowErrors={rowErrors} onEdit={openProvider} onDelete={deleteProvider} />
            : <RolesPanel snapshot={snapshot} roles={roles} dirty={rolesDirty} busy={busy} saving={saving} onChange={(role, value) => {
                setRoles(current => ({ ...current, [role]: value }));
                setNotice('');
              }} onSave={saveRoles} />}
          <SettingsOverview snapshot={snapshot} view={view} />
        </div>}
      </main>
      {isServicePage && <ProviderDrawer
        editor={editor}
        dialogRef={dialogRef}
        busy={busy}
        saving={saving}
        error={providerError}
        onDirty={() => setEditorDirty(true)}
        onError={setProviderError}
        onClose={closeProvider}
        onSave={saveProvider}
      />}
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Settings mount point is missing.');
createRoot(container).render(<Settings view={document.body.dataset.settingsView === 'api' ? 'api' : 'agents'} />);
