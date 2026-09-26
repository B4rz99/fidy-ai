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

const AuthenticationRouter = ({ apiOrigin }: Readonly<{ apiOrigin: string }>): JSX.Element => {
  const { expireAuthentication } = useSession();
  const [router] = useState(() =>
    createWebRouter({
      apiClient: makeFidyClient(apiOrigin, undefined, {
        onAuthenticationExpired: expireAuthentication,
      }),
      webAuthClient: makeWebAuthClient(apiOrigin),
      hostedTurnClient: makeHostedTurnClient(apiOrigin),
      history: Option.none(),
    })
  );
  return <RouterProvider router={router} />;
};

const RoutedApplication = (): JSX.Element => {
  const apiOrigin = parseApiOrigin(import.meta.env.VITE_API_ORIGIN);
  const makeEnrollmentClient = useCallback(
    () => makeSubscriptionEnrollmentClient(apiOrigin),
    [apiOrigin]
  );
  return (
    <SubscriptionEnrollmentLifetime makeClient={makeEnrollmentClient}>
      <AuthenticationRouter apiOrigin={apiOrigin} />
    </SubscriptionEnrollmentLifetime>
  );
};

/** Composes the production browser application from Vite's validated API-origin configuration. */
export const WebApplication = (): JSX.Element => (
  <SessionRegistryProvider>
    <RoutedApplication />
  </SessionRegistryProvider>
);
