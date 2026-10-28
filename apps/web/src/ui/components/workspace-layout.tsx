import { Option } from "effect";
import type { JSX, ReactNode } from "react";
import { WorkspaceDesktop, useWorkspaceSize } from "./workspace-responsive";

export const WorkspaceHeader = ({
  title,
  context,
  children,
}: Readonly<{ title: string; context: ReactNode; children: ReactNode }>): JSX.Element => (
  <header className="workspace-page-header flex min-h-18 flex-wrap items-center justify-between gap-4 border-b px-5 py-3">
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {context}
    </div>
    {children !== null && (
      <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center [&>:only-child]:col-span-full">
        {children}
      </div>
    )}
  </header>
);

export const WorkspaceColumns = ({
  children,
  panel,
  variant,
}: Readonly<{
  children: ReactNode;
  panel: ReactNode;
  variant: "default" | "container";
}>): JSX.Element => {
  const { desktop, measure } = useWorkspaceSize();
  if (variant === "default") {
    return (
      <div className="grid items-stretch xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 p-5">{children}</div>
        {panel}
      </div>
    );
  }
  return (
    <WorkspaceDesktop value={Option.some(desktop)}>
      <div ref={measure} className="min-w-0">
        <div
          className={
            desktop
              ? "grid items-stretch grid-cols-[minmax(0,1fr)_24rem]"
              : "grid items-stretch grid-cols-1"
          }
        >
          <div className="min-w-0 p-5">{children}</div>
          {panel}
        </div>
      </div>
    </WorkspaceDesktop>
  );
};

export const RecordToolbar = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
  <div className="mb-4 flex flex-wrap items-center gap-2 [&_button]:px-3">{children}</div>
);
