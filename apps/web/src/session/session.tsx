import { RegistryProvider } from "@effect/atom-react";
import { Option } from "effect";
import { useState } from "react";
import type { ReactNode } from "react";
import { type BrowserAuthentication, SessionContext } from "./session-context";

/** A local, non-secret epoch identifying one authentication lifetime. */
export type AuthenticationLifetime = number;

type SessionRegistryProviderProps = Readonly<{
  readonly children: ReactNode;
}>;

/**
 * Provides session transitions and isolates Atom state to one authentication lifetime. Calling
 * `replaceAuthenticationLifetime` remounts the registry, making cached server state from the prior
 * lifetime unavailable across login, logout, and explicit pairing-restart transitions. Canonical
 * authentication expiry joins this same interface in #241.
 */
export const SessionRegistryProvider = ({
  children,
}: SessionRegistryProviderProps): React.JSX.Element => {
  const [authenticationEpoch, setAuthenticationEpoch] = useState<AuthenticationLifetime>(0);
  const [authentication, setAuthentication] = useState<BrowserAuthentication>("signed-out");
  const replaceAuthenticationLifetime = (): void => {
    setAuthenticationEpoch((currentEpoch) => currentEpoch + 1);
  };
  const transitionAuthentication = (next: typeof authentication): void => {
    setAuthentication(next);
    replaceAuthenticationLifetime();
  };
  const completeLogin = (): void => transitionAuthentication("signed-in");
  const completeLogout = (): void => transitionAuthentication("signed-out");
  const expireAuthentication = (): void => {
    if (authentication !== "expired") transitionAuthentication("expired");
  };

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
      <RegistryProvider key={authenticationEpoch}>{children}</RegistryProvider>
    </SessionContext.Provider>
  );
};
