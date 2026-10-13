import { Option } from "effect";
import { type ReactNode, useCallback, useState } from "react";
import {
  type BrowserSessionLifetime,
  loadBrowserSessionBinding,
} from "@/transport/session-binding";
import { authenticationEndedEvent } from "./authentication-events";
import { useSession } from "./session-context";

type BindingState = Readonly<{ session: BrowserSessionLifetime; checking: boolean }>;
type BindingObserver = Readonly<{
  apiOrigin: string;
  expired: () => void;
  update: (state: BindingState) => void;
  failed: () => void;
}>;

/** Resume checks retain the exact same session object so feature owners do not remount on focus. */
const observeBinding = ({ apiOrigin, expired, update, failed }: BindingObserver): (() => void) => {
  const lifetime = new AbortController();
  let session = Option.none<BrowserSessionLifetime>();
  let checking = false;
  const retire = (): void => lifetime.abort();
  const validate = (): void => {
    if (lifetime.signal.aborted || checking) {
      return;
    }
    checking = true;
    Option.map(session, (value) => update({ session: value, checking: true }));
    loadBrowserSessionBinding({ apiOrigin, signal: lifetime.signal }).then(
      (current) => {
        if (lifetime.signal.aborted) {
          return;
        }
        if (Option.isSome(session) && current !== session.value.binding) {
          retire();
          expired();
          return;
        }
        session = Option.orElse(session, () =>
          Option.some({ binding: current, signal: lifetime.signal, expired })
        );
        checking = false;
        Option.map(session, (value) => update({ session: value, checking: false }));
      },
      () => {
        if (!lifetime.signal.aborted) {
          retire();
          failed();
        }
      }
    );
  };
  const visible = (): void => {
    if (document.visibilityState === "visible") {
      validate();
    }
  };
  const restored = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      validate();
    }
  };
  window.addEventListener(authenticationEndedEvent, retire);
  window.addEventListener("pageshow", restored);
  document.addEventListener("visibilitychange", visible);
  validate();
  return () => {
    retire();
    window.removeEventListener(authenticationEndedEvent, retire);
    window.removeEventListener("pageshow", restored);
    document.removeEventListener("visibilitychange", visible);
  };
};

/** Mount authenticated owners only after latching identity; resume never silently adopts another User. */
export const BrowserSessionBoundary = ({
  apiOrigin,
  children,
}: Readonly<{
  apiOrigin: string;
  children: (session: BrowserSessionLifetime) => ReactNode;
}>): React.JSX.Element => {
  const { expireAuthentication } = useSession();
  const [state, setState] = useState<Option.Option<BindingState>>(Option.none());
  const [failed, setFailed] = useState(false);
  const attach = useCallback(
    (_node: HTMLSpanElement): (() => void) =>
      observeBinding({
        apiOrigin,
        expired: expireAuthentication,
        update: (value) => setState(Option.some(value)),
        failed: () => {
          setState(Option.none());
          setFailed(true);
        },
      }),
    [apiOrigin, expireAuthentication]
  );
  return (
    <>
      <span hidden ref={attach} />
      {Option.match(state, {
        onNone: () => (
          <p role={failed ? "alert" : "status"}>
            {failed
              ? "No pudimos comprobar tu sesión. Recarga para continuar."
              : "Comprobando sesión…"}
          </p>
        ),
        onSome: ({ session, checking }) => (
          <div inert={checking} hidden={checking}>
            {children(session)}
          </div>
        ),
      })}
    </>
  );
};
