import type { JSX } from "react";
import { EmailReplacementFeature } from "@/features/email-replacement/feature";
import { BackupRecoveryFeature } from "@/features/recovery/feature";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";

export const AccountPage = (): JSX.Element => (
  <main className="settings-workspace settings-account">
    <WorkspaceHeader title="Cuenta" context={null}>
      {null}
    </WorkspaceHeader>
    <div className="settings-main">
      <EmailReplacementFeature />
      <BackupRecoveryFeature />
    </div>
  </main>
);
