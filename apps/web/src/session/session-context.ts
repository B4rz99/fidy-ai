import { Option } from "effect";
import { createContext, useContext } from "react";

/** Browser-visible authentication state; it contains no credential or server-owned User data. */
export type BrowserAuthentication = "signed-out" | "signed-in" | "expired";

/** Owns browser-visible session state and every explicit authentication-lifetime transition. */
export type SessionContextValue = Readonly<{
  readonly authentication: BrowserAuthentication;
  readonly completeLogin: () => void;
  readonly completeLogout: () => void;
  readonly expireAuthentication: () => void;
  readonly replaceAuthenticationLifetime: () => void;
}>;

/** Carries the session transition surface above the registry that it replaces. */
export const SessionContext = createContext<Option.Option<SessionContextValue>>(Option.none());

/** Returns the session transition surface owned by the surrounding application session. */
export const useSession = (): SessionContextValue => {
  const session = useContext(SessionContext);
  if (Option.isNone(session)) {
    throw new Error("useSession must be used within SessionRegistryProvider");
  }
  return session.value;
};
