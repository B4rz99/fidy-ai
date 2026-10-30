import type { InitialBrowserSession } from "@/transport/initial-session";
import type {
  BrowserSessionLifetime,
  BrowserSessionObservation,
} from "@/transport/session-binding";
import { initialApplicationValues } from "./initial-values";
import { RegistryContext, RegistryProvider } from "@effect/atom-react";
import { BrowserSessionBoundary } from "@/session/browser-session-boundary";
import { RouterProvider } from "@tanstack/react-router";
import { Option } from "effect";
import { useCallback, useContext, useState } from "react";
import type { JSX } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { useSession } from "@/session/session-context";
import { SubscriptionEnrollmentLifetime } from "@/session/subscription-enrollment-lifetime";
import {
  type FidyClient,
  type HostedTurnClient,
  type WebAuthClient,
  makeFidyClient,
  makeHostedTurnClient,
  makeSubscriptionEnrollmentClient,
  makeWebAuthClient,
} from "@/transport/client";
import { parseApiOrigin } from "@/transport/origin";
import { createWebRouter } from "./routes";

type Clients = Readonly<{
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  hostedTurnClient: HostedTurnClient;
}>;
const makeClients = ({
  apiOrigin,
  session,
  expired,
}: Readonly<{
  apiOrigin: string;
  session: BrowserSessionLifetime;
  expired: () => void;
}>): Clients => ({
  apiClient: makeFidyClient({ apiOrigin, session, observer: { onAuthenticationExpired: expired } }),
  webAuthClient: makeWebAuthClient({ apiOrigin, session }),
  hostedTurnClient: makeHostedTurnClient({ apiOrigin, session }),
});
const AuthenticationRouter = ({
  clients,
  session,
}: Readonly<{ clients: Clients; session: BrowserSessionLifetime }>): JSX.Element => {
  const registry = useContext(RegistryContext);
  const [router] = useState(() =>
    createWebRouter({
      ...clients,
      registry,
      sessionBinding: session.binding,
      history: Option.none(),
    })
  );
  return <RouterProvider router={router} />;
};

const BoundApplication = ({
  apiOrigin,
  session,
  initial,
}: Readonly<{
  apiOrigin: string;
  session: BrowserSessionLifetime;
  initial: BrowserSessionObservation;
}>): JSX.Element => {
  const { expireAuthentication } = useSession();
  const [clients] = useState(() =>
    makeClients({ apiOrigin, session, expired: expireAuthentication })
  );
  const [initialValues] = useState(() => initialApplicationValues({ ...clients, initial }));
  const makeEnrollmentClient = useCallback(
    () => makeSubscriptionEnrollmentClient({ apiOrigin, session }),
    [apiOrigin, session]
  );
  return (
    <RegistryProvider initialValues={initialValues}>
      <SubscriptionEnrollmentLifetime makeClient={makeEnrollmentClient}>
        <AuthenticationRouter clients={clients} session={session} />
      </SubscriptionEnrollmentLifetime>
    </RegistryProvider>
  );
};
const RoutedApplication = ({
  initial,
}: Readonly<{ initial: InitialBrowserSession }>): JSX.Element => {
  const apiOrigin = parseApiOrigin(import.meta.env.VITE_API_ORIGIN);
  return (
    <BrowserSessionBoundary apiOrigin={apiOrigin} initial={initial}>
      {(session, observation) => (
        <BoundApplication apiOrigin={apiOrigin} session={session} initial={observation} />
      )}
    </BrowserSessionBoundary>
  );
};

export const WebApplication = ({
  initial,
}: Readonly<{ initial: InitialBrowserSession }>): JSX.Element => (
  <SessionRegistryProvider>
    <RoutedApplication initial={initial} />
  </SessionRegistryProvider>
);
