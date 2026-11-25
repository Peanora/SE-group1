import type { ReactNode } from 'react';

export function ToolShell({ id, skipLabel, returnLabel, children }: {
  id: string;
  skipLabel: string;
  returnLabel: string;
  children: ReactNode;
}) {
  return (
    <>
      <a className="tools-skip" href={`#${id}`}>{skipLabel}</a>
      <header className="tools-header">
        <a className="tools-brand" href="/" aria-label="Taskflow 工作台首页">
          <span className="tools-brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <strong>Taskflow</strong>
        </a>
        <a className="tools-back" href="/"><span aria-hidden="true">‹</span> {returnLabel}</a>
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
