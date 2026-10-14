import type { JSX } from "react";
import { OAuthManagementFeature } from "@/features/oauth-connections/feature";
import { PATManagementFeature } from "@/features/pats/feature";
import { WorkspaceColumns, WorkspaceHeader } from "@/ui/components/workspace-layout";

/** Combines access management without coupling token and MCP grant lifetimes or commands. */
export const AccessManagementPage = (): JSX.Element => (
  <PATManagementFeature>
    {({ tokens, creation }) => (
      <main className="flex min-h-svh min-w-0 flex-col xl:grid xl:grid-rows-[auto_1fr]">
        <WorkspaceHeader
          title="Accesos"
          context={
            <p className="mt-1 text-sm text-muted-foreground">
              Administra los tokens y las conexiones de tus agentes.
            </p>
          }
        >
          {null}
        </WorkspaceHeader>
        <WorkspaceColumns
          variant="default"
          panel={
            <aside className="min-w-0 border-t bg-card p-5 xl:border-t-0 xl:border-l">
              {creation}
            </aside>
          }
        >
          <div className="flex min-w-0 flex-col gap-8">
            {tokens}
            <div className="min-w-0 border-t pt-6">
              <OAuthManagementFeature />
            </div>
          </div>
        </WorkspaceColumns>
      </main>
    )}
  </PATManagementFeature>
);
