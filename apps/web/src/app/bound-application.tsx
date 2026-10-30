import { RouterProvider } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useCallback, useState } from "react";
import type { BrowserSessionLifetime } from "@/transport/session-binding";
import { useSession } from "@/session/session-context";
import { SubscriptionEnrollmentLifetime } from "@/session/subscription-enrollment-lifetime";
import {
  makeFidyClient,
  makeHostedTurnClient,
  makeSubscriptionEnrollmentClient,
  makeWebAuthClient,
} from "@/transport/client";
import { createWebRouter } from "./routes";

const AuthenticationRouter = ({
  apiOrigin,
  session,
}: Readonly<{
  apiOrigin: string;
  session: BrowserSessionLifetime;
}>): JSX.Element => {
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
      initialSessionBinding: session.binding,
    })
  );
  return <RouterProvider router={router} />;
};

export const BoundApplication = ({
  apiOrigin,
  session,
}: Readonly<{
  apiOrigin: string;
  session: BrowserSessionLifetime;
}>): JSX.Element => {
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
