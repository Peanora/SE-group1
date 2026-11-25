import type { ReactNode } from 'react';

export function workbenchUrl(projectId?: string | null, runId?: string | null) {
  if (!projectId) return '/';
  const query = new URLSearchParams({ project: projectId });
  if (runId) query.set('run', runId);
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
          <svg className="tools-brand-mark" viewBox="0 0 28 28" aria-hidden="true">
            <rect width="28" height="28" rx="5" />
            <path d="M6.5 14h7.5m0 0V8m0 6v6m0-12h7.5m-7.5 12h7.5" />
            <circle cx="6.5" cy="14" r="1.6" /><circle cx="21.5" cy="8" r="1.6" /><circle cx="21.5" cy="20" r="1.6" />
          </svg>
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
