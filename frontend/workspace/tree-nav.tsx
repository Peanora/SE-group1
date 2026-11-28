import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, CircleDot, Eye, FolderTree, LayoutGrid, Menu, PanelLeftClose, PanelLeftOpen, Send } from 'lucide-react';

type Leaf = {
  id: string;
  label: string;
  view: string;
  tab?: string;
  pane?: string;
  target?: string;
  action?: 'issue' | 'changes';
};

type Group = { view: string; label: string; leaves: Leaf[] };

const groups: Group[] = [
  { view: 'source', label: '需求', leaves: [
    { id: 'source-current', label: '当前版本', view: 'source' },
    { id: 'source-changes', label: '变更记录', view: 'source', action: 'changes', target: '#source-changes-section' },
  ] },
  { view: 'plan', label: '规格与计划', leaves: [
    { id: 'plan-stages', label: '规划阶段与产物', view: 'plan', target: '#workflow-details' },
    { id: 'plan-issues', label: '查看问题', view: 'plan', action: 'issue', target: '#planning-issue-host' },
  ] },
  { view: 'tasks', label: '开发任务', leaves: [
    { id: 'task-graph', label: '模块依赖图', view: 'tasks', tab: 'tasks' },
    { id: 'task-schedule', label: '计划清单', view: 'tasks', tab: 'schedule' },
    { id: 'task-artifacts', label: '规划文档', view: 'tasks', tab: 'artifacts' },
    { id: 'task-events', label: '规划事件', view: 'tasks', tab: 'events' },
  ] },
  { view: 'execution', label: '执行验收', leaves: [
    { id: 'exec-overview', label: '交付总览', view: 'execution', pane: 'overview' },
    { id: 'exec-checklist', label: '验收清单', view: 'execution', pane: 'checklist' },
    { id: 'exec-candidates', label: '候选与证据', view: 'execution', pane: 'candidates' },
    { id: 'exec-releases', label: '本机版本', view: 'execution', pane: 'releases' },
  ] },
  { view: 'trace', label: '运行复盘', leaves: [
    { id: 'trace-events', label: '运行记录', view: 'trace' },
  ] },
];

const allLeaves = groups.flatMap(group => group.leaves);
const firstLeaf = (view: string) => allLeaves.find(leaf => leaf.view === view) ?? allLeaves[0];
const treeEvent = 'taskflow:tree-leaf';
const collapsedKey = 'taskflow.tree.collapsed';
let activeLeaf: Leaf = allLeaves[0];

function markActive(leaf: Leaf) {
  activeLeaf = leaf;
  document.querySelectorAll('[data-tree-leaf]').forEach(node => {
    node.setAttribute('aria-current', (node as HTMLElement).dataset.treeLeaf === leaf.id ? 'page' : 'false');
  });
  window.dispatchEvent(new CustomEvent<Leaf>(treeEvent, { detail: leaf }));
}

function clickTab(view: string) {
  const tab = document.querySelector<HTMLButtonElement>(`[data-workspace-view="${view}"]`);
  if (tab && !tab.disabled && tab.getAttribute('aria-selected') !== 'true') tab.click();
}

export function WorkspaceTree() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const nav = document.querySelector<HTMLElement>('#workspace-nav');
    if (!nav) return;
    if (nav.parentElement !== host) host.append(nav);
    nav.setAttribute('aria-label', '项目目录');

    const children: HTMLElement[] = [];
    for (const group of groups) {
      const tab = nav.querySelector<HTMLElement>(`[data-workspace-view="${group.view}"]`);
      if (!tab) continue;
      const box = document.createElement('div');
      box.className = 'tree-children';
      for (const leaf of group.leaves) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tree-leaf';
        button.dataset.treeLeaf = leaf.id;
        button.textContent = leaf.label;
        box.append(button);
      }
      tab.after(box);
      children.push(box);
    }

    if (localStorage.getItem(collapsedKey) === 'true') document.body.classList.add('tree-collapsed');
    markActive(activeLeaf);

    function openIssuePanel() {
      const reviewIssue = document.querySelector<HTMLButtonElement>('[data-review-issue]');
      if (reviewIssue && !reviewIssue.disabled && reviewIssue.getClientRects().length > 0) { reviewIssue.click(); return; }
      const next = document.querySelector<HTMLButtonElement>('#workspace-next-root');
      if (next && !next.disabled && /查看问题|查看失败/.test(next.textContent ?? '')) next.click();
    }

    function openChangeHistory() {
      const section = document.querySelector<HTMLElement>('#source-changes-section');
      const history = section?.querySelector<HTMLDetailsElement>('.sc-version-history');
      if (history) history.open = true;
    }

    function onClick(event: MouseEvent) {
      const target = event.target as Element;
      const toggle = target.closest<HTMLElement>('#tree-collapse');
      if (toggle) {
        const collapsed = document.body.classList.toggle('tree-collapsed');
        localStorage.setItem(collapsedKey, String(collapsed));
        return;
      }
      const leafButton = target.closest<HTMLElement>('[data-tree-leaf]');
      if (!leafButton || !host?.contains(leafButton)) return;
      const leaf = allLeaves.find(item => item.id === leafButton.dataset.treeLeaf);
      if (!leaf) return;
      clickTab(leaf.view);
      if (leaf.action === 'issue') openIssuePanel();
      if (leaf.action === 'changes') openChangeHistory();
      if (leaf.tab) document.querySelector<HTMLButtonElement>(`[data-tab="${leaf.tab}"]`)?.click();
      if (leaf.pane) document.querySelector<HTMLButtonElement>(`[data-delivery-surface="${leaf.pane}"]`)?.click();
      if (leaf.target) {
        window.setTimeout(() => {
          const node = document.querySelector(leaf.target as string);
          if (!(node instanceof HTMLElement)) return;
          if (node instanceof HTMLDetailsElement) node.open = true;
          node.scrollIntoView({ block: 'start' });
        }, 80);
      }
      document.body.classList.remove('tree-open');
      markActive(leaf);
    }
    host.addEventListener('click', onClick);

    function onTreeEvent(event: Event) {
      const leaf = (event as CustomEvent<Leaf>).detail;
      if (!leaf) return;
      document.querySelectorAll('[data-tree-leaf]').forEach(node => {
        node.setAttribute('aria-current', (node as HTMLElement).dataset.treeLeaf === leaf.id ? 'page' : 'false');
      });
    }
    window.addEventListener(treeEvent, onTreeEvent);

    function syncFromControls() {
      const innerTab = document.querySelector<HTMLElement>('[data-tab][aria-selected="true"]');
      if (document.body.dataset.studioView === 'tasks' && innerTab?.dataset.tab) {
        const leaf = allLeaves.find(item => item.view === 'tasks' && item.tab === innerTab.dataset.tab);
        if (leaf && leaf.id !== activeLeaf.id) { markActive(leaf); return; }
      }
      const surface = document.querySelector<HTMLElement>('[data-delivery-surface][aria-selected="true"]');
      if (document.body.dataset.studioView === 'execution' && surface?.dataset.deliverySurface) {
        const leaf = allLeaves.find(item => item.view === 'execution' && item.pane === surface.dataset.deliverySurface);
        if (leaf && leaf.id !== activeLeaf.id) { markActive(leaf); return; }
      }
      const view = document.body.dataset.studioView;
      if (view && view !== activeLeaf.view) { markActive(firstLeaf(view)); return; }
      const group = document.querySelector('#breadcrumb-project');
      if (group?.textContent) window.dispatchEvent(new CustomEvent('taskflow:tree-project', { detail: group.textContent }));
    }
    const observer = new MutationObserver(syncFromControls);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-studio-view'] });
    observer.observe(host, { attributes: true, attributeFilter: ['aria-selected'], subtree: true });
    syncFromControls();

    return () => {
      host.removeEventListener('click', onClick);
      window.removeEventListener(treeEvent, onTreeEvent);
      observer.disconnect();
      children.forEach(node => node.remove());
    };
  }, []);

  return (
    <aside id="workspace-tree" className="workspace-tree" aria-label="项目目录">
      <div className="tree-heading">
        <span className="tree-heading-icon"><FolderTree size={17} aria-hidden="true" /></span>
        <span className="tree-heading-text">项目目录</span>
        <button type="button" id="tree-collapse" className="tree-collapse" aria-label="收起或展开目录">
          <PanelLeftClose size={16} aria-hidden="true" className="tree-collapse-open" />
          <PanelLeftOpen size={16} aria-hidden="true" className="tree-collapse-closed" />
        </button>
      </div>
      <div ref={hostRef} className="tree-groups" />
    </aside>
  );
}

export function WorkspaceBreadcrumb() {
  const [leaf, setLeaf] = useState<Leaf>(activeLeaf);
  const [project, setProject] = useState('工作台');

  useEffect(() => {
    const onLeaf = (event: Event) => setLeaf((event as CustomEvent<Leaf>).detail);
    const onProject = (event: Event) => setProject((event as CustomEvent<string>).detail || '工作台');
    window.addEventListener(treeEvent, onLeaf);
    window.addEventListener('taskflow:tree-project', onProject);
    const updateProject = () => {
      const node = document.querySelector('#breadcrumb-project');
      if (node?.textContent) setProject(node.textContent);
    };
    updateProject();
    const observer = new MutationObserver(updateProject);
    const node = document.querySelector('#breadcrumb-project');
    if (node) observer.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      window.removeEventListener(treeEvent, onLeaf);
      window.removeEventListener('taskflow:tree-project', onProject);
      observer.disconnect();
    };
  }, []);

  const group = groups.find(item => item.view === leaf.view);
  return (
    <nav id="workspace-breadcrumb" aria-label="当前位置">
      <button type="button" className="tree-mobile-toggle" aria-label="打开目录"
        onClick={() => document.body.classList.toggle('tree-open')}><Menu size={16} aria-hidden="true" />目录</button>
      <button type="button" onClick={() => clickTab('source')}>{project}</button>
      <ChevronRight size={13} aria-hidden="true" />
      <button type="button" onClick={() => { const first = firstLeaf(leaf.view); clickTab(first.view); markActive(first); }}>{group?.label}</button>
      <ChevronRight size={13} aria-hidden="true" />
      <span aria-current="page">{leaf.label}</span>
    </nav>
  );
}

const focusKey = 'taskflow.focus';
const secondaryDetails = ['#run-history', '.workspace-budget', '#simulation-tools', '.workspace-scope'];

export function FocusModeToggle() {
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('focus')) localStorage.setItem(focusKey, params.get('focus') === '1' ? 'true' : 'false');
    const saved = localStorage.getItem(focusKey);
    const enabled = saved === null ? false : saved === 'true';
    setFocus(enabled);
    document.body.classList.toggle('focus-mode', enabled);
    if (enabled) {
      for (const selector of secondaryDetails) {
        const details = document.querySelector<HTMLDetailsElement>(selector);
        if (!details) continue;
        details.dataset.focusRestore = details.open ? '1' : '0';
        details.open = false;
      }
    }
  }, []);

  function toggle() {
    const enabled = !focus;
    setFocus(enabled);
    localStorage.setItem(focusKey, String(enabled));
    document.body.classList.toggle('focus-mode', enabled);
    for (const selector of secondaryDetails) {
      const details = document.querySelector<HTMLDetailsElement>(selector);
      if (!details) continue;
      if (enabled) {
        details.dataset.focusRestore = details.open ? '1' : '0';
        details.open = false;
      } else if (details.dataset.focusRestore === '1') {
        details.open = true;
      }
      delete details.dataset.focusRestore;
    }
  }

  return (
    <button type="button" id="focus-toggle" className="studio-tool-button" aria-pressed={focus}
      aria-label={focus ? '切换到全览模式' : '切换到专注模式'} title={focus ? '当前：简洁专注' : '当前：完整全览'}
      onClick={toggle}>
      {focus ? <Eye size={16} aria-hidden="true" /> : <LayoutGrid size={16} aria-hidden="true" />}
      <span>{focus ? '简洁' : '全览'}</span>
    </button>
  );
}

function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

export function NextStepPanel() {
  const [title, setTitle] = useState('先导入一份软件需求');
  const [note, setNote] = useState('选择项目后查看当前步骤和需要处理的问题。');
  const [text, setText] = useState('');
  const [canStart, setCanStart] = useState(false);

  useEffect(() => {
    const sync = () => {
      const nextTitle = document.querySelector('#workspace-context-title')?.textContent;
      const nextNote = document.querySelector('#workspace-context-note')?.textContent;
      const start = document.querySelector<HTMLButtonElement>('#start-run');
      if (nextTitle) setTitle(nextTitle);
      if (nextNote) setNote(nextNote);
      setCanStart(Boolean(start && !start.disabled));
    };
    sync();
    const host = document.querySelector('#workspace-context');
    if (!host) return;
    const observer = new MutationObserver(sync);
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  function startIfNeeded() {
    const start = document.querySelector<HTMLButtonElement>('#start-run');
    if (start && !start.disabled) { start.click(); return true; }
    return false;
  }

  function primary() {
    if (startIfNeeded()) return;
    document.querySelector<HTMLButtonElement>('#workspace-next-root')?.click();
  }

  function shortcut(kind: string) {
    if (kind === 'issues') { document.querySelector<HTMLElement>('[data-tree-leaf="plan-issues"]')?.click(); return; }
    if (kind === 'spec' || kind === 'plan') {
      const stage = document.querySelector<HTMLButtonElement>(`[data-delivery-step="${kind === 'spec' ? 'spec' : 'plan'}"]`);
      if (stage && !stage.disabled) stage.click();
      else startIfNeeded();
      return;
    }
    if (kind === 'download') {
      const bundle = document.querySelector<HTMLAnchorElement>('#download-bundle');
      const source = bundle && !bundle.hidden ? bundle : document.querySelector<HTMLAnchorElement>('#automatic-download');
      if (source && !source.hidden && source.href) source.click();
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    const issue = document.querySelector<HTMLTextAreaElement>('[data-issue-draft-description]');
    if (issue && issue.getClientRects().length > 0) { setNativeValue(issue, value); issue.focus(); setText(''); return; }
    const feature = document.querySelector<HTMLElement>('.sc-feature');
    const featureText = feature?.querySelector<HTMLTextAreaElement>('textarea');
    if (featureText && (feature?.getClientRects().length ?? 0) > 0) { setNativeValue(featureText, value); featureText.focus(); setText(''); return; }
    const add = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === '新增功能');
    if (add && !add.disabled) {
      add.click();
      window.setTimeout(() => {
        const target = document.querySelector<HTMLTextAreaElement>('.sc-feature textarea');
        if (target) { setNativeValue(target, value); target.focus(); }
      }, 60);
      setText('');
    }
  }

  return (
    <section id="next-step-panel" aria-label="下一步操作">
      <div className="next-step-status">
        <span className="studio-region-label"><CircleDot size={14} aria-hidden="true" />当前进度</span>
        <strong id="next-step-title">{title}</strong>
        <p id="next-step-note">{note}</p>
      </div>
      <button type="button" id="next-step-primary" className="button button-primary" onClick={primary}>{canStart ? '开始编排' : '处理当前步骤'}</button>
      <form className="next-step-form" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="next-step-input">输入需求或回答</label>
        <input id="next-step-input" value={text} onChange={event => setText(event.target.value)} placeholder="输入需求或回答，回车提交" />
        <button type="submit" aria-label="提交输入"><Send size={15} aria-hidden="true" /></button>
      </form>
      <div className="next-step-shortcuts" aria-label="快捷操作">
        <button type="button" onClick={() => shortcut('issues')}>查看问题</button>
        <button type="button" onClick={() => shortcut('spec')}>生成规格</button>
        <button type="button" onClick={() => shortcut('plan')}>确认计划</button>
        <button type="button" onClick={() => shortcut('download')}>下载文档包</button>
      </div>
    </section>
  );
}
