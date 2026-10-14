import { Option } from "effect";
import { createContext, useContext } from "react";

/** Browser-visible authentication state; it contains no credential or server-owned User data. */
export type BrowserAuthentication = "signed-out" | "signed-in" | "expired";

export type SessionContextValue = Readonly<{
  readonly authentication: BrowserAuthentication;
  readonly completeLogin: () => void;
  readonly completeLogout: () => void;
  readonly expireAuthentication: () => void;
  readonly replaceAuthenticationLifetime: () => void;
}>;

export const SessionContext = createContext<Option.Option<SessionContextValue>>(Option.none());

export const useSession = (): SessionContextValue => {
  const session = useContext(SessionContext);
  if (Option.isNone(session)) {
    throw new Error("useSession must be used within SessionRegistryProvider");
  }
  return session.value;
};
