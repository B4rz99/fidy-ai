import type { JSX } from "react";
import { OAuthManagementFeature } from "@/features/oauth-connections/feature";
import { PATManagementFeature } from "@/features/pats/feature";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";

export const AccessManagementPage = (): JSX.Element => (
  <PATManagementFeature>
    {({ tokens, creation, refresh }) => (
      <main className="settings-workspace">
        <WorkspaceHeader title="Accesos" context={null}>
          {refresh}
        </WorkspaceHeader>
        <div className="settings-columns">
          <div className="settings-main settings-access-main">
            {tokens}
            <OAuthManagementFeature />
          </div>
          <div className="settings-panel">{creation}</div>
        </div>
      </main>
    )}
  </PATManagementFeature>
);
