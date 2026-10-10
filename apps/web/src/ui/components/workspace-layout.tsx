import type { JSX, ReactNode } from "react";

/** Keeps the page title and responsive actions aligned; features supply their own context and commands. */
export const WorkspaceHeader = ({
  title,
  context,
  children,
}: Readonly<{ title: string; context: ReactNode; children: ReactNode }>): JSX.Element => (
  <header className="workspace-page-header flex min-h-18 flex-wrap items-center justify-between gap-4 border-b px-5 py-3">
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {context}
    </div>
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
      {children}
    </div>
  </header>
);

/** Reserves the desktop rail while stacking its content below the records on smaller screens. */
export const WorkspaceColumns = ({
  children,
  panel,
}: Readonly<{ children: ReactNode; panel: ReactNode }>): JSX.Element => (
  <div className="grid items-stretch xl:grid-cols-[minmax(0,1fr)_24rem]">
    <div className="min-w-0 p-5">{children}</div>
    {panel}
  </div>
);

/** Wraps compact record controls without separating filters from actions. */
export const RecordToolbar = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
  <div className="mb-4 flex flex-wrap items-center gap-2 [&_button]:px-3">{children}</div>
);
