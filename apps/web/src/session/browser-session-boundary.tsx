import type { InitialBrowserSession } from "@/transport/initial-session";
import { type Cause, Effect, Option } from "effect";
import { type ReactNode, useCallback, useState } from "react";
import {
  type BrowserSessionEntryFailure,
  type BrowserSessionLifetime,
  type BrowserSessionObservation,
  loadBrowserSessionEntry,
} from "@/transport/session-binding";
import { authenticationEndedEvent } from "./authentication-events";
import { useSession } from "./session-context";

type BindingState = Readonly<{
  session: BrowserSessionLifetime;
  checking: boolean;
  initial: BrowserSessionObservation;
}>;
type BindingObserver = Readonly<{
  apiOrigin: string;
  initial: InitialBrowserSession;
  owner: object;
  expired: () => void;
  update: (state: BindingState) => void;
  failed: () => void;
}>;
const observeBindingEvents = (validate: () => void, retire: () => void): (() => void) => {
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
const bindingRead = (
  prepared: ReturnType<InitialBrowserSession["take"]>,
  apiOrigin: string,
  first: boolean
): Effect.Effect<BrowserSessionObservation, BrowserSessionEntryFailure | Cause.UnknownError> =>
  Option.match(prepared, {
    onNone: () =>
      loadBrowserSessionEntry({
        apiOrigin,
        context: first && window.location.pathname.startsWith("/app/"),
        request: Option.none(),
      }),
    onSome: (work) => work.result.pipe(Effect.flatMap((result) => result)),
  });
/** Resume checks retain the exact same session object so feature owners do not remount on focus. */
const retainedBinding = (
  input: Readonly<{
    session: Option.Option<BrowserSessionLifetime>;
    observation: Option.Option<BrowserSessionObservation>;
    current: BrowserSessionObservation;
    signal: AbortSignal;
    expired: () => void;
  }>
): BindingState => ({
  session: Option.getOrElse(input.session, () => ({
    binding: input.current.binding,
    signal: input.signal,
    expired: input.expired,
  })),
  initial: Option.getOrElse(input.observation, () => input.current),
  checking: false,
});
const retirePreparedBinding =
  (lifetime: AbortController, prepared: ReturnType<InitialBrowserSession["take"]>): (() => void) =>
  () => {
    lifetime.abort();
    Option.map(prepared, (work) => work.cancel());
  };
const markChecking = (
  session: Option.Option<BrowserSessionLifetime>,
  observation: Option.Option<BrowserSessionObservation>,
  update: BindingObserver["update"]
): void => {
  if (Option.isSome(session) && Option.isSome(observation)) {
    update({ session: session.value, checking: true, initial: observation.value });
  }
};
const observeBinding = ({
  apiOrigin,
  initial,
  owner,
  expired,
  update,
  failed,
}: BindingObserver): (() => void) => {
  const lifetime = new AbortController();
  let session = Option.none<BrowserSessionLifetime>();
  let checking = false;
  let observation = Option.none<BrowserSessionObservation>();
  const first = initial.apiOrigin === apiOrigin ? initial.take(owner) : Option.none();
  let consumed = false;
  const retire = retirePreparedBinding(lifetime, first);
  const validate = (): void => {
    if (lifetime.signal.aborted || checking) {
      return;
    }
    checking = true;
    markChecking(session, observation, update);
    const prepared = consumed ? Option.none() : first;
    consumed = true;
    Effect.runFork(
      bindingRead(prepared, apiOrigin, Option.isNone(session)).pipe(
        Effect.matchCause({
          onSuccess: (current) => {
            if (lifetime.signal.aborted) {
              return;
            }
            if (Option.isSome(session) && current.binding !== session.value.binding) {
              retire();
              expired();
              return;
            }
            const retained = retainedBinding({
              session,
              observation,
              current,
              signal: lifetime.signal,
              expired,
            });
            session = Option.some(retained.session);
            observation = Option.some(retained.initial);
            checking = false;
            update(retained);
          },
          onFailure: () => {
            if (!lifetime.signal.aborted) {
              retire();
              failed();
            }
          },
        })
      ),
      { signal: lifetime.signal }
    );
  };
  return observeBindingEvents(validate, retire);
};
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
