import { RouterProvider } from "@tanstack/react-router";
import { Option } from "effect";
import { useState } from "react";
import type { JSX } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { useSession } from "@/session/session-context";
import {
  makeFidyClient,
  makeSubscriptionEnrollmentClient,
  makeWebAuthClient,
} from "@/transport/client";
import { parseApiOrigin } from "@/transport/origin";
import { createWebRouter } from "./routes";

const RoutedApplication = (): JSX.Element => {
  const { expireAuthentication } = useSession();
  const [router] = useState(() => {
    const apiOrigin = parseApiOrigin(import.meta.env.VITE_API_ORIGIN);
    return createWebRouter({
      apiClient: makeFidyClient(apiOrigin, undefined, {
        onAuthenticationExpired: expireAuthentication,
      }),
      webAuthClient: makeWebAuthClient(apiOrigin),
      subscriptionEnrollmentClient: makeSubscriptionEnrollmentClient(apiOrigin),
      history: Option.none(),
    });
  });
  return <RouterProvider router={router} />;
};

/** Composes the production browser application from Vite's validated API-origin configuration. */
export const WebApplication = (): JSX.Element => (
  <SessionRegistryProvider>
    <RoutedApplication />
  </SessionRegistryProvider>
);
