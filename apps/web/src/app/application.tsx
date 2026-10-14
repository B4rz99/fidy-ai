import { BrowserSessionBoundary } from "@/session/browser-session-boundary";
import type { BrowserSessionLifetime } from "@/transport/session-binding";
import { RouterProvider } from "@tanstack/react-router";
import { Option } from "effect";
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { useSession } from "@/session/session-context";
import { SubscriptionEnrollmentLifetime } from "@/session/subscription-enrollment-lifetime";
import {
  makeFidyClient,
  makeHostedTurnClient,
  makeSubscriptionEnrollmentClient,
  makeWebAuthClient,
} from "@/transport/client";
import { parseApiOrigin } from "@/transport/origin";
import { createWebRouter } from "./routes";

const AuthenticationRouter = ({
  apiOrigin,
  session,
}: Readonly<{ apiOrigin: string; session: BrowserSessionLifetime }>): JSX.Element => {
  const { expireAuthentication } = useSession();
  const [router] = useState(() =>
    createWebRouter({
      apiClient: makeFidyClient({
        apiOrigin,
        session,
        observer: {
          onAuthenticationExpired: () => {
            expireAuthentication();
          },
        },
      }),
      webAuthClient: makeWebAuthClient({ apiOrigin, session }),
      hostedTurnClient: makeHostedTurnClient({ apiOrigin, session }),
      history: Option.none(),
    })
  );
  return <RouterProvider router={router} />;
};

const BoundApplication = ({
  apiOrigin,
  session,
}: Readonly<{ apiOrigin: string; session: BrowserSessionLifetime }>): JSX.Element => {
  const makeEnrollmentClient = useCallback(
    () => makeSubscriptionEnrollmentClient({ apiOrigin, session }),
    [apiOrigin, session]
  );
  return (
    <SubscriptionEnrollmentLifetime makeClient={makeEnrollmentClient}>
      <AuthenticationRouter apiOrigin={apiOrigin} session={session} />
    </SubscriptionEnrollmentLifetime>
  );
};
const RoutedApplication = (): JSX.Element => {
  const apiOrigin = parseApiOrigin(import.meta.env.VITE_API_ORIGIN);
  return (
    <BrowserSessionBoundary apiOrigin={apiOrigin}>
      {(session) => <BoundApplication apiOrigin={apiOrigin} session={session} />}
    </BrowserSessionBoundary>
  );
};

export const WebApplication = (): JSX.Element => (
  <SessionRegistryProvider>
    <RoutedApplication />
  </SessionRegistryProvider>
);
