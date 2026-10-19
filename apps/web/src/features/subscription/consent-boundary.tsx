import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import { useSession } from "@/session/session-context";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { BrowserSessionBinding, ProcessingConsentStatus } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";

const missingSession = (
  session: CanonicalQueryState<typeof BrowserSessionBinding.Type, unknown>
): boolean => session._tag === "Ready" && session.value.binding === null;

const ConsentRequired = ({ revoked }: Readonly<{ revoked: boolean }>): JSX.Element => (
  <Alert>
    <AlertTitle>
      {revoked ? "Tu autorización está retirada" : "Necesitas autorizar el tratamiento de datos"}
    </AlertTitle>
    <AlertDescription className="flex flex-col items-start gap-3">
      <p>
        Activar Pro requiere una autorización de tratamiento vigente. Iniciar sesión no la renueva.
      </p>
      <Button render={<Link to="/settings/privacy" />} size="sm">
        Revisar privacidad
      </Button>
    </AlertDescription>
  </Alert>
);

const ConsentResult = ({
  status,
  refresh,
  children,
}: Readonly<{
  status: CanonicalQueryState<ProcessingConsentStatus, unknown>;
  refresh: () => void;
  children: ReactNode;
}>): JSX.Element => {
  if (status._tag === "Initial" || status.waiting) {
    return <output>Verificando autorización…</output>;
  }
  if (status._tag === "Failure" || Option.isSome(status.refreshFailure)) {
    return (
      <Alert>
        <AlertTitle>No pudimos verificar tu autorización</AlertTitle>
        <AlertDescription>
          <Button onClick={refresh} variant="outline">
            Reintentar
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (status.value.status === "Granted") return <>{children}</>;
  return <ConsentRequired revoked={status.value.status === "Revoked"} />;
};

/** Check cookie-only Consent before mounting ordinary Subscription queries or payment controls. */
export const SubscriptionConsentBoundary = ({
  children,
}: Readonly<{ children: ReactNode }>): JSX.Element => {
  const client = useRouter().options.context.webAuthClient;
  const [query] = useState(() =>
    client.query("processingConsent", "status", {
      timeToLive: "0 seconds",
      reactivityKeys: ["processing-consent"],
    })
  );
  const status = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  const { authentication } = useSession();
  const [binding] = useState(() => client.query("browserSession", "binding", {}));
  const session = useAtomValue(binding).pipe(presentCanonicalQuery);
  if (authentication === "expired" || (status._tag === "Failure" && missingSession(session))) {
    return (
      <Alert>
        <AlertTitle>Inicia sesión para activar Pro</AlertTitle>
        <AlertDescription>
          <Button render={<Link to="/login" reloadDocument />} size="sm">
            Iniciar sesión
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <ConsentResult status={status} refresh={refresh}>
      {children}
    </ConsentResult>
  );
};
