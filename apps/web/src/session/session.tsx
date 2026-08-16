import { RegistryProvider } from "@effect/atom-react";
import type { ReactNode } from "react";

export type AuthenticationLifetime = string;

type SessionRegistryProviderProps = Readonly<{
  readonly authenticationLifetime: AuthenticationLifetime;
  readonly children: ReactNode;
}>;

/**
 * Isolates Atom state to one authentication lifetime. Cached server state from a prior lifetime is
 * unavailable after the lifetime changes, including across login, logout, and expiry transitions.
 */
export const SessionRegistryProvider = ({
  authenticationLifetime,
  children,
}: SessionRegistryProviderProps): React.JSX.Element => (
  <RegistryProvider key={authenticationLifetime}>{children}</RegistryProvider>
);
