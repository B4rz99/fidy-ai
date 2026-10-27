import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  InformationCircleIcon,
  Shield01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { JSX, ReactNode } from "react";
import { Alert, AlertDescription } from "./alert";
import { WorkspaceHeader } from "./workspace-layout";
import "./oauth-review.css";

export const OAuthWorkspace = ({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>): JSX.Element => (
  <main className="settings-workspace oauth-workspace">
    <WorkspaceHeader title={title} context={null}>
      {null}
    </WorkspaceHeader>
    {children}
  </main>
);

export const OAuthClient = ({
  name,
  children,
}: Readonly<{ name: string; children: ReactNode }>): JSX.Element => (
  <section className="oauth-client">
    <span className="settings-section-icon">
      <HugeiconsIcon icon={Shield01Icon} size={28} strokeWidth={1.5} aria-hidden="true" />
    </span>
    <h2 className="settings-section-title">{name}</h2>
    <div className="oauth-client-body">
      <OAuthNotice kind="warning">
        Nombre declarado por el cliente; Fidy no verifica su identidad.
      </OAuthNotice>
      {children}
    </div>
  </section>
);

export const OAuthNotice = ({
  kind,
  children,
}: Readonly<{ kind: "warning" | "information"; children: ReactNode }>): JSX.Element => (
  <Alert variant={kind} role="note" className="oauth-notice">
    <HugeiconsIcon
      icon={kind === "warning" ? Alert02Icon : InformationCircleIcon}
      size={24}
      className="size-6"
      aria-hidden="true"
    />
    <AlertDescription>{children}</AlertDescription>
  </Alert>
);

const stateIcons = {
  warning: Alert02Icon,
  success: Tick02Icon,
  information: InformationCircleIcon,
};

type StateProps = Readonly<{
  title: string;
  kind: "warning" | "success" | "information";
  children: ReactNode;
}>;

export const OAuthStatus = ({ title, kind, children }: StateProps): JSX.Element => (
  <section
    className="oauth-state"
    data-kind={kind}
    role={kind === "warning" ? "region" : "status"}
    aria-label={title}
  >
    <span className="oauth-state-icon">
      <HugeiconsIcon icon={stateIcons[kind]} size={24} aria-hidden="true" />
    </span>
    <h2>{title}</h2>
    <div className="oauth-state-body">{children}</div>
  </section>
);

export const OAuthState = (props: StateProps): JSX.Element => (
  <OAuthWorkspace title="Autorizaciones">
    <OAuthStatus {...props} />
  </OAuthWorkspace>
);
