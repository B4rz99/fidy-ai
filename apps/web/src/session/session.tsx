import { queryLifetime } from "@/transport/query-lifetime";
import {
  announceAuthenticationTransition,
  authenticationEndedEvent,
  observeAuthenticationTransitions,
} from "./authentication-events";
import { RegistryContext, RegistryProvider } from "@effect/atom-react";
import { Option } from "effect";
import { useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { type BrowserAuthentication, SessionContext } from "./session-context";

/** A local, non-secret epoch identifying one authentication lifetime. */
export type AuthenticationLifetime = number;

type SessionRegistryProviderProps = Readonly<{
  readonly children: ReactNode;
}>;

const QueryLifetime = (): React.JSX.Element => {
  const registry = useContext(RegistryContext);
  const initialize = useCallback(
    (_node: HTMLSpanElement): void => {
      queryLifetime(registry);
    },
    [registry]
  );
  return <span ref={initialize} hidden />;
};

/** Replacing the authentication lifetime makes prior cached server state unavailable. */
export const SessionRegistryProvider = ({
  children,
}: SessionRegistryProviderProps): React.JSX.Element => {
  const [authenticationEpoch, setAuthenticationEpoch] = useState<AuthenticationLifetime>(0);
  const [authentication, setAuthentication] = useState<BrowserAuthentication>("signed-out");
  const replaceAuthenticationLifetime = (): void => {
    window.dispatchEvent(new Event(authenticationEndedEvent));
    setAuthenticationEpoch((currentEpoch) => currentEpoch + 1);
  };
  const transitionAuthentication = (next: typeof authentication): void => {
    announceAuthenticationTransition();
    setAuthentication(next);
    replaceAuthenticationLifetime();
  };
  const completeLogin = (): void => transitionAuthentication("signed-in");
  const completeLogout = (): void => transitionAuthentication("signed-out");
  const expireAuthentication = (): void => {
    if (authentication !== "expired") transitionAuthentication("expired");
  };

  const observe = useCallback(
    (_node: HTMLSpanElement): (() => void) =>
      observeAuthenticationTransitions(() => {
        window.dispatchEvent(new Event(authenticationEndedEvent));
        setAuthentication("expired");
        setAuthenticationEpoch((current) => current + 1);
      }),
    []
  );

  return (
    <SessionContext.Provider
      value={Option.some({
        authentication,
        completeLogin,
        completeLogout,
        expireAuthentication,
        replaceAuthenticationLifetime,
      })}
    >
      <span ref={observe} hidden />
      <RegistryProvider key={authenticationEpoch}>
        <QueryLifetime />
        {children}
      </RegistryProvider>
    </SessionContext.Provider>
  );
};
