import type { InitialBrowserSession } from "@/transport/initial-session";
import { type Cause, Effect, Option } from "effect";
import type { BrowserSessionLifetime } from "@/transport/session-binding";
import {
  type BrowserSessionEntryFailure,
  type BrowserSessionObservation,
  loadBrowserSessionEntry,
} from "@/transport/session-entry";
import { authenticationEndedEvent } from "./authentication-events";

export type BindingState = Readonly<{
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
    onSome: (work) => Effect.flatten(work.result),
  });
/** Resume checks retain the exact same session object so feature owners do not remount on focus. */
const retainedBinding = (
  input: Readonly<{
    session: Option.Option<BrowserSessionLifetime>;
    observation: Option.Option<BrowserSessionObservation>;
    current: BrowserSessionObservation;
    signal: AbortSignal;
    recheck: () => void;
  }>
): BindingState => ({
  session: Option.getOrElse(input.session, () => ({
    binding: input.current.binding,
    signal: input.signal,
    recheck: input.recheck,
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
export const observeBinding = ({
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
              recheck: validate,
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
