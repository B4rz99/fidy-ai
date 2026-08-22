import { RegistryProvider } from "@effect/atom-react";
import { Option } from "effect";
import { useState } from "react";
import type { ReactNode } from "react";
import { SessionContext } from "./session-context";

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
  const [loginCompletedInLifetime, setLoginCompletedInLifetime] = useState(false);
  const replaceAuthenticationLifetime = (): void => {
    setAuthenticationEpoch((currentEpoch) => currentEpoch + 1);
  };
  const completeLogin = (): void => {
    setLoginCompletedInLifetime(true);
    replaceAuthenticationLifetime();
  };
  const completeLogout = (): void => {
    setLoginCompletedInLifetime(false);
    replaceAuthenticationLifetime();
  };

  return (
    <SessionContext.Provider
      value={Option.some({
        loginCompletedInLifetime,
        completeLogin,
        completeLogout,
        replaceAuthenticationLifetime,
      })}
    >
      <RegistryProvider key={authenticationEpoch}>{children}</RegistryProvider>
    </SessionContext.Provider>
  );
};
