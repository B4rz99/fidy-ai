import type { InitialBrowserSession } from "@/transport/initial-session";
import { Option } from "effect";
import { type ReactNode, useCallback, useRef, useState } from "react";
import type { BrowserSessionLifetime } from "@/transport/session-binding";
import type { BrowserSessionObservation } from "@/transport/session-entry";
import { useSession } from "./session-context";
import { type BindingState, observeBinding } from "./session-observer";

type BoundaryState = Readonly<{ binding: BindingState; key: number }>;

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
  const [state, setState] = useState<Option.Option<BoundaryState>>(() => Option.none());
  const [failed, setFailed] = useState(false);
  const [owner] = useState(() => ({}));
  const sessionKeys = useRef(new WeakMap<BrowserSessionLifetime, number>());
  const nextSessionKey = useRef(0);

  const attach = useCallback(
    (_node: HTMLSpanElement): (() => void) =>
      observeBinding({
        apiOrigin,
        initial,
        owner,
        expired: expireAuthentication,
        update: (binding) => {
          const existing = sessionKeys.current.get(binding.session);
          const key = existing ?? ++nextSessionKey.current;
          sessionKeys.current.set(binding.session, key);
          setState(Option.some({ binding, key }));
        },
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
        <div
          key={state.value.key}
          inert={state.value.binding.checking}
          hidden={state.value.binding.checking}
        >
          {children(state.value.binding.session, state.value.binding.initial)}
        </div>
      )}
    </>
  );
};
