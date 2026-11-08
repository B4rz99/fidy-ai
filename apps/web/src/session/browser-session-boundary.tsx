import type { InitialBrowserSession } from "@/transport/initial-session";
import { Option } from "effect";
import { type ReactNode, useCallback, useState } from "react";
import type { BrowserSessionLifetime } from "@/transport/session-binding";
import type { BrowserSessionObservation } from "@/transport/session-entry";
import { useSession } from "./session-context";
import { type BindingState, observeBinding } from "./session-observer";

/** Mount authenticated owners only after latching identity; resume never silently adopts another User. */
export const BrowserSessionBoundary = ({
  apiOrigin,
  initial,
  pending,
  children,
}: Readonly<{
  pending: ReactNode;
  apiOrigin: string;
  initial: InitialBrowserSession;
  children: (session: BrowserSessionLifetime, initial: BrowserSessionObservation) => ReactNode;
}>): React.JSX.Element => {
  const { expireAuthentication } = useSession();
  const [state, setState] = useState<Option.Option<BindingState>>(() => Option.none());
  const [failed, setFailed] = useState(false);
  const [owner] = useState(() => ({}));
  const attach = useCallback(
    (_node: HTMLSpanElement): (() => void) =>
      observeBinding({
        apiOrigin,
        initial,
        owner,
        expired: expireAuthentication,
        update: (value) => setState(Option.some(value)),
        failed: () => {
          setState(Option.none());
          setFailed(true);
        },
      }),
    [apiOrigin, initial, owner, expireAuthentication]
  );
  const pendingContent = failed ? (
    <p role="alert">No pudimos comprobar tu sesión. Recarga para continuar.</p>
  ) : (
    pending
  );
  return (
    <>
      <span hidden ref={attach} />
      {Option.isNone(state) ? (
        pendingContent
      ) : (
        <div inert={state.value.checking} hidden={state.value.checking}>
          {children(state.value.session, state.value.initial)}
        </div>
      )}
    </>
  );
};
