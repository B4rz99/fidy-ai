import { PendingRead } from "@/ui/components/pending-read";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Option, Predicate } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import { useSession } from "@/session/session-context";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { ProcessingConsentStatus } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";

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
  if (Predicate.isTagged(status, "Initial") || status.waiting) {
    return <PendingRead label="Cargando ofertas" />;
  }

  if (Predicate.isTagged(status, "Failure") || Option.isSome(status.refreshFailure)) {
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

export const SubscriptionConsentBoundary = ({
  children,
}: Readonly<{ children: ReactNode }>): JSX.Element => {
  const { webAuthClient: client, sessionBinding } = useRouter().options.context;

  const [query] = useState(() =>
    client.query("processingConsent", "status", {
      timeToLive: "0 seconds",
      reactivityKeys: ["processing-consent"],
    })
  );

  const status = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  const { authentication } = useSession();

  if (
    authentication === "expired" ||
    (Predicate.isTagged(status, "Failure") && sessionBinding === "none")
  ) {
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
