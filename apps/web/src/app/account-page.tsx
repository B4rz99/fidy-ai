import type { JSX } from "react";
import { EmailReplacementFeature } from "@/features/email-replacement/feature";
import { BackupRecoveryFeature } from "@/features/recovery/feature";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";

export const AccountPage = (): JSX.Element => (
  <main className="flex min-w-0 flex-col">
    <WorkspaceHeader
      title="Cuenta"
      context={
        <p className="mt-1 text-sm text-muted-foreground">
          Administra tu correo de acceso y tu código de recuperación.
        </p>
      }
    >
      {null}
    </WorkspaceHeader>
    <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-6 sm:px-6">
      <EmailReplacementFeature />
      <BackupRecoveryFeature />
    </div>
  </main>
);
