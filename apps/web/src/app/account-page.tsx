import type { JSX } from "react";
import { EmailReplacementFeature } from "@/features/email-replacement/feature";
import { BackupRecoveryFeature } from "@/features/recovery/feature";

export const AccountPage = (): JSX.Element => (
  <main className="settings-workspace settings-account">
    <header className="settings-header">
      <h1>Cuenta</h1>
    </header>
    <div className="settings-main">
      <EmailReplacementFeature />
      <BackupRecoveryFeature />
    </div>
  </main>
);
