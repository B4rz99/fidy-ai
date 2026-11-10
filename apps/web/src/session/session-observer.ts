import type { InitialBrowserSession } from "@/transport/initial-session";
import { type Cause, Effect, Option } from "effect";
import type { BrowserSessionLifetime } from "@/transport/session-binding";
import {
  type BrowserSessionEntryFailure,
  type BrowserSessionObservation,
  loadBrowserSessionEntry,
} from "@/transport/session-entry";
import { authenticationEndedEvent } from "./authentication-events";

type BindingEntry = Readonly<{
  session: BrowserSessionLifetime;
  initial: BrowserSessionObservation;
}>;
type BindingLifecycle =
  | Readonly<{ _tag: "CheckingInitial" }>
  | Readonly<{ _tag: "Bound"; entry: BindingEntry }>
  | Readonly<{ _tag: "Rechecking"; entry: BindingEntry }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Retired" }>
  | Readonly<{ _tag: "Disposed" }>;
export type BindingState = BindingEntry & Readonly<{ checking: boolean }>;
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
    if (document.visibilityState === "visible") validate();
  };
  const restored = (event: PageTransitionEvent): void => {
    if (event.persisted) validate();
  };
  window.addEventListener(authenticationEndedEvent, retire);
  window.addEventListener("pageshow", restored);
  document.addEventListener("visibilitychange", visible);
  validate();
  return () => {
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

const createEntry = (
  current: BrowserSessionObservation,
  signal: AbortSignal,
  recheck: () => void
): BindingEntry => ({ session: { binding: current.binding, signal, recheck }, initial: current });

const cancelBinding = (
  lifetime: AbortController,
  prepared: ReturnType<InitialBrowserSession["take"]>
): void => {
  lifetime.abort();
  Option.map(prepared, (work) => work.cancel());
};

export const observeBinding = (input: BindingObserver): (() => void) => {
  const { apiOrigin, initial, owner, expired, update, failed } = input;
  const lifetime = new AbortController();
  let state: BindingLifecycle = { _tag: "CheckingInitial" };
  const first = initial.apiOrigin === apiOrigin ? initial.take(owner) : Option.none();
  let consumed = false;
  const cancel = (): void => cancelBinding(lifetime, first);
  const retire = (): void => {
    if (state._tag === "CheckingInitial" || state._tag === "Bound" || state._tag === "Rechecking") {
      state = { _tag: "Retired" };
      cancel();
    }
  };
  const validate = (): void => {
    if (state._tag === "Bound") {
      state = { _tag: "Rechecking", entry: state.entry };
      update({ ...state.entry, checking: true });
    } else if (state._tag !== "CheckingInitial" || consumed) {
      return;
    }
    const prepared = consumed ? Option.none() : first;
    consumed = true;
    Effect.runFork(
      bindingRead(prepared, apiOrigin, state._tag === "CheckingInitial").pipe(
        Effect.matchCause({
          onSuccess: (current) => {
            if (state._tag !== "CheckingInitial" && state._tag !== "Rechecking") return;
            if (state._tag === "Rechecking" && current.binding !== state.entry.session.binding) {
              retire();
              expired();
              return;
            }
            const entry =
              state._tag === "Rechecking"
                ? state.entry
                : createEntry(current, lifetime.signal, validate);
            state = { _tag: "Bound", entry };
            update({ ...entry, checking: false });
          },
          onFailure: () => {
            if (state._tag === "CheckingInitial" || state._tag === "Rechecking") {
              state = { _tag: "Unavailable" };
              cancel();
              failed();
            }
          },
        })
      ),
      { signal: lifetime.signal }
    );
  };
  const removeListeners = observeBindingEvents(validate, retire);
  return () => {
    state = { _tag: "Disposed" };
    cancel();
    removeListeners();
  };
};
