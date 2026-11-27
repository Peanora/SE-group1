import type { ReactNode } from 'react';

export function workbenchUrl(projectId?: string | null, runId?: string | null, view?: string | null) {
  if (!projectId) return '/';
  const query = new URLSearchParams({ project: projectId });
  if (runId) query.set('run', runId);
  if (view) query.set('view', view);
  return `/?${query}`;
}

export function ToolShell({ id, skipLabel, returnLabel, returnHref = '/', children }: {
  id: string;
  skipLabel: string;
  returnLabel: string;
  returnHref?: string;
  children: ReactNode;
}) {
  return (
    <>
      <a className="tools-skip" href={`#${id}`}>{skipLabel}</a>
      <header className="tools-header">
        <a className="tools-brand" href="/" aria-label="Taskflow 工作台首页">
          <img className="tools-brand-mark" src="/taskflow.svg" width="25" height="25" alt="" />
          <strong>Taskflow</strong>
        </a>
        <a className="tools-back" href={returnHref}><span aria-hidden="true">‹</span> {returnLabel}</a>
      </header>
      <main className="tools-main" id={id} tabIndex={-1}>{children}</main>
    </>
  );
}

export function ToolMessages({ prefix, error, notice }: { prefix: string; error: string; notice: string }) {
  return (
    <>
      <p id={`${prefix}-error`} role="alert" className="tools-message tools-error" hidden={!error}>{error}</p>
      <p id={`${prefix}-notice`} role="status" className="tools-message" hidden={!notice}>{notice}</p>
    </>
  );
}
