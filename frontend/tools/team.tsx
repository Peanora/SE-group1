import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ToolMessages, ToolShell, workbenchUrl } from './shell';

const roles = { owner: '负责人', reviewer: '评审者', observer: '观察者' };
type Role = keyof typeof roles;
type Member = { id: string; name: string; role: Role; active: boolean };
type Session = { enabled: boolean; setupRequired: boolean; user: Member | null };
type AuditEvent = { seq: number; at: number; actor_role: Role | null; action: string; status: number; target: string; request_id: string };
const permissions = {
  owner: '可以开发、变更需求、管理成员和审阅。发布到外部时需要独立授权。',
  reviewer: '可以查看项目，确认或驳回规格、计划及测试定义。',
  observer: '可以查看团队项目、报告和交付。',
};
const actions: Record<string, string> = {
  'team.setup': '设置负责人', 'team.login': '登录', 'team.login_failed': '登录失败',
  'team.logout': '退出账号', 'team.member_created': '添加成员', 'team.member_updated': '更新成员权限',
  'request.finished': '操作结果', 'request.denied': '拒绝越权操作',
};
const query = new URLSearchParams(location.search);
const returnHref = workbenchUrl(query.get('project'), query.get('run'));

async function teamRequest<T>(route: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(`/api/team/${route}`, {
    method, cache: 'no-store', credentials: 'same-origin',
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || '当前操作尚未确认，请刷新核对。'), { status: response.status });
  }
  return data;
}

function MemberRow({ member, disabled, onSave }: {
  member: Member;
  disabled: boolean;
  onSave: (member: Member, role: Role, active: boolean) => void;
}) {
  const [role, setRole] = useState(member.role);
  const [active, setActive] = useState(member.active);
  return (
    <div className="team-member" data-member-id={member.id}>
      <strong className="team-member-identity">{member.name}</strong>
      <label className="tools-field">
        <span>角色</span>
        <select aria-label={`${member.name}的角色`} value={role} onChange={event => setRole(event.target.value as Role)}>
          {Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="tools-check">
        <input type="checkbox" aria-label={`启用${member.name}`} checked={active} onChange={event => setActive(event.target.checked)} />
        <span>{active ? '已启用' : '已停用'}</span>
      </label>
      <button type="button" className="tools-button" disabled={disabled} onClick={() => onSave(member, role, active)}>保存权限</button>
    </div>
  );
}

export function TeamPage() {
  const [session, setSession] = useState<Session>();
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [moreAudit, setMoreAudit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const currentSession = useRef<Session>(undefined);
  const lock = useRef(false);
  const cursor = useRef(0);
  const loginName = useRef<HTMLInputElement>(null);
  const loginPassword = useRef<HTMLInputElement>(null);
  const memberForm = useRef<HTMLFormElement>(null);
  const memberName = useRef<HTMLInputElement>(null);
  const memberPassword = useRef<HTMLInputElement>(null);
  const user = session?.user;
  const showLogin = Boolean(session?.enabled && !user);
  const showAudit = user?.role === 'owner' || user?.role === 'reviewer';

  useLayoutEffect(() => {
    if (showLogin) loginName.current?.focus();
  }, [showLogin]);

  async function readSession() {
    const previousUser = currentSession.current?.user;
    const next = await teamRequest<Session>('session');
    currentSession.current = next;
    if (!next.user) {
      memberForm.current?.reset();
      if (memberPassword.current) memberPassword.current.value = '';
      setMembers([]);
      setEvents([]);
      setMoreAudit(false);
      cursor.current = 0;
      if (previousUser && loginName.current) loginName.current.value = previousUser.name;
      if (previousUser && loginPassword.current) loginPassword.current.value = '';
    }
    setSession(next);
    return next;
  }

  async function readMembers() {
    return (await teamRequest<{ members: Member[] }>('members')).members;
  }

  async function readAudit(reset = false) {
    const result = await teamRequest<{ events: AuditEvent[]; cursor: number }>(`audit?after=${reset ? 0 : cursor.current}`);
    cursor.current = result.cursor;
    setEvents(previous => reset ? result.events : [...previous, ...result.events]);
    setMoreAudit(result.events.length === 200);
  }

  async function perform(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '当前操作尚未确认，请刷新核对。');
      if (failure && typeof failure === 'object' && 'status' in failure && failure.status === 401) {
        await readSession().catch(() => {});
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    void perform(async () => {
      const next = await readSession();
      if (next.user?.role === 'owner') setMembers(await readMembers());
      if (next.user?.role === 'owner' || next.user?.role === 'reviewer') await readAudit(true);
    });
  }, []);

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !loginName.current || !loginPassword.current) return;
    const name = loginName.current.value;
    const password = loginPassword.current.value;
    void perform(async () => {
      await teamRequest(session.setupRequired ? 'setup' : 'login', 'POST', { name, password });
      const next = await readSession();
      if (next.user?.name !== name.normalize('NFC')) throw new Error('登录状态尚未核对，请刷新后查看。');
      if (loginPassword.current) loginPassword.current.value = '';
      window.location.assign(returnHref);
    });
  }

  function logout() {
    void perform(async () => {
      await teamRequest('logout', 'POST', {});
      const next = await readSession();
      if (next.user) throw new Error('退出状态尚未核对，请刷新。');
      setNotice('已退出当前账号。');
    });
  }

  function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('username'));
    const password = String(form.get('password'));
    const role = form.get('role') as Role;
    void perform(async () => {
      const added = await teamRequest<{ member: Member }>('members', 'POST', { name, password, role });
      const fresh = await readMembers();
      if (!fresh.some(item => item.id === added.member?.id && item.name === name.normalize('NFC') && item.role === role && item.active)) {
        throw new Error('新账号状态尚未核对，请刷新成员列表。');
      }
      if (memberName.current) memberName.current.value = '';
      if (memberPassword.current) memberPassword.current.value = '';
      setMembers(fresh);
      setNotice('已核对新成员账号。请将初始密码告知该成员。');
    });
  }

  function saveMember(member: Member, role: Role, active: boolean) {
    void perform(async () => {
      await teamRequest(`members/${encodeURIComponent(member.id)}`, 'PATCH', { role, active });
      const next = await readSession();
      if (next.user?.role === 'owner') {
        const fresh = await readMembers();
        if (!fresh.some(item => item.id === member.id && item.role === role && item.active === active)) {
          throw new Error('权限更新尚未核对，请刷新后查看。');
        }
        setMembers(fresh);
      }
      setNotice(next.user ? '已核对保存后的权限。该成员需要重新登录。' : '当前账号权限已更新，请重新登录。');
    });
  }

  const description = !session ? '正在核对登录状态…' : !session.enabled
    ? '本地单人模式正在使用。需要团队登录时，请在本地配置中开启团队模式并重启服务。'
    : session.setupRequired ? '首次开启团队模式，请先设置负责人账号。负责人可以添加其他成员。'
      : user?.role === 'owner' ? '管理成员访问权限并核对变更记录。'
        : user?.role === 'reviewer' ? '查看账号权限及项目操作记录。'
          : user ? '' : '登录后可查看团队项目并按账号权限操作。';

  return (
    <ToolShell id="team-main" skipLabel="跳到账号操作" returnLabel="返回工作台" returnHref={returnHref}>
      <div className={`team-layout${showLogin ? ' team-layout-login' : ''}`}>
        <header className="team-heading">
          <h1>团队账号</h1>
          <p id="team-description" hidden={!description}>{description}</p>
          <dl className="team-role-guide" hidden={!showLogin}>
            <div><dt>负责人</dt><dd>管理成员并推进开发</dd></div>
            <div><dt>评审者</dt><dd>核对规格、计划和测试定义</dd></div>
            <div><dt>观察者</dt><dd>查看项目、报告和交付</dd></div>
          </dl>
          <ToolMessages prefix="team" error={error} notice={notice} />
        </header>
        <section id="team-login" className="team-auth" aria-labelledby="login-title" hidden={!showLogin}>
          <form id="login-form" onSubmit={login}>
            <h2 id="login-title">{session?.setupRequired ? '设置负责人账号' : '登录工作台'}</h2>
            <label className="tools-field" htmlFor="login-name">
              <span>账号</span>
              <input id="login-name" ref={loginName} name="username" autoComplete="username" maxLength={48} required />
            </label>
            <label className="tools-field" htmlFor="login-password">
              <span>密码</span>
              <input id="login-password" ref={loginPassword} name="password" type="password"
                autoComplete={session?.setupRequired ? 'new-password' : 'current-password'}
                minLength={12} maxLength={128} aria-describedby="login-password-hint" required />
              <small id="login-password-hint">至少 12 个字符。密码仅用于团队登录。</small>
            </label>
            <button id="login-submit" className="tools-button tools-primary" type="submit" disabled={busy}>
              {session?.setupRequired ? '设置并登录' : '登录'}
            </button>
          </form>
        </section>
      </div>
      <section id="team-account" className={user?.role === 'owner' ? 'team-organization' : 'team-organization team-organization-self'} hidden={!user}>
        <section id="member-admin" className="team-admin" hidden={user?.role !== 'owner'}>
          <header className="team-section-heading">
            <h2>成员与权限</h2>
            <div className="team-member-tools">
              <span>{members.length} 位成员</span>
              <button id="member-refresh" type="button" className="tools-text-button" disabled={busy} onClick={() => void perform(async () => {
                setMembers(await readMembers());
                setNotice('已刷新成员列表。');
              })}>刷新成员</button>
            </div>
          </header>
          <p className="team-member-warning">修改角色或停用账号会撤销该成员的现有会话。</p>
          <details className="team-add">
            <summary>添加团队成员</summary>
            <form id="member-form" className="team-member-form" ref={memberForm} onSubmit={addMember}>
              <label className="tools-field" htmlFor="member-name">
                <span>新账号</span>
                <input id="member-name" ref={memberName} name="username" autoComplete="off" maxLength={48} required />
              </label>
              <label className="tools-field" htmlFor="member-password">
                <span>初始密码</span>
                <input id="member-password" ref={memberPassword} name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
              </label>
              <label className="tools-field" htmlFor="member-role">
                <span>角色</span>
                <select id="member-role" name="role" defaultValue="observer">
                  {(['observer', 'reviewer', 'owner'] as const).map(role => <option key={role} value={role}>{roles[role]}</option>)}
                </select>
              </label>
              <button className="tools-button tools-primary" type="submit" disabled={busy}>添加成员</button>
            </form>
          </details>
          <div className="team-member-columns" aria-hidden="true">
            <span>账号</span><span>角色</span><span>状态</span><span>操作</span>
          </div>
          <div id="members" className="team-members">
            {members.map(member => <MemberRow key={`${member.id}:${member.role}:${member.active}`} member={member} disabled={busy} onSave={saveMember} />)}
          </div>
        </section>
        <aside className="team-actions" aria-label="当前账号与操作">
          <section className="tools-account">
            <h2 id="account-name">{user && <>{user.name} <span>{roles[user.role] ?? '未知角色'}</span></>}</h2>
            <p id="account-permission">{user && (permissions[user.role] ?? '账号权限待核对。')}</p>
            <button id="logout" className="tools-button" disabled={busy} onClick={logout}>退出当前账号</button>
          </section>
          <section id="team-audit" className="team-audit" hidden={!showAudit}>
            <div className="team-section-heading">
              <h2>操作记录</h2>
              <button id="audit-refresh" className="tools-text-button" disabled={busy} onClick={() => void perform(() => readAudit(true))}>刷新记录</button>
            </div>
            <ol id="audit-list">
              {events.map(event => {
                const label = actions[event.action] || (event.action.startsWith('request.') ? '提交操作请求' : '账号操作');
                const outcome = event.status === 0 ? 'pending' : event.status < 400 ? 'passed' : 'failed';
                const result = outcome === 'pending' ? '已受理，结果待核对' : outcome === 'passed' ? '已完成' : `未通过（${event.status}）`;
                const time = new Date(event.at);
                return (
                  <li key={event.seq} data-outcome={outcome}>
                    <div className="team-audit-event">
                      <strong>{label}</strong>
                      <time dateTime={Number.isFinite(time.getTime()) ? time.toISOString() : undefined}>{time.toLocaleString('zh-CN')}</time>
                    </div>
                    <span>{event.actor_role ? roles[event.actor_role] : '访客'} <b>{result}</b></span>
                    {(event.target || event.request_id) && (
                      <details><summary>关联记录</summary><code>{[event.target, event.request_id].filter(Boolean).join('\n')}</code></details>
                    )}
                  </li>
                );
              })}
            </ol>
            <button id="audit-more" className="tools-button" hidden={!moreAudit} disabled={busy} onClick={() => void perform(() => readAudit())}>加载后续记录</button>
          </section>
        </aside>
      </section>
    </ToolShell>
  );
}
