import type { InitialBrowserSession } from "@/transport/initial-session";
import { browserRuntime } from "@/transport/browser-runtime";
import { type Cause, Data, Effect, Option, Predicate } from "effect";
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

type BindingLifecycle = Data.TaggedEnum<{
  CheckingInitial: {};
  Bound: { readonly entry: BindingEntry };
  Rechecking: { readonly entry: BindingEntry };
  Unavailable: {};
  Retired: {};
  Disposed: {};
}>;

const BindingLifecycle = Data.taggedEnum<BindingLifecycle>();

const checkingInitial = BindingLifecycle.$is("CheckingInitial");

const rechecking = BindingLifecycle.$is("Rechecking");

const reading = Predicate.or(checkingInitial, rechecking);

const retirable = Predicate.or(reading, BindingLifecycle.$is("Bound"));

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
  let state: BindingLifecycle = BindingLifecycle.CheckingInitial();
  const first = initial.apiOrigin === apiOrigin ? initial.take(owner) : Option.none();
  let consumed = false;
  const cancel = (): void => cancelBinding(lifetime, first);

  const retire = (): void => {
    if (retirable(state)) {
      state = BindingLifecycle.Retired();
      cancel();
    }
  };

  const validate = (): void => {
    if (BindingLifecycle.$is("Bound")(state)) {
      state = BindingLifecycle.Rechecking({ entry: state.entry });
      update({ ...state.entry, checking: true });
    } else if (!checkingInitial(state) || consumed) {
      return;
    }

    const prepared = consumed ? Option.none() : first;
    consumed = true;
    browserRuntime.runFork(
      bindingRead(prepared, apiOrigin, checkingInitial(state)).pipe(
        Effect.matchCause({
          onSuccess: (current) => {
            if (!reading(state)) return;

            if (rechecking(state) && current.binding !== state.entry.session.binding) {
              retire();
              expired();

              return;
            }

            const entry = rechecking(state)
              ? state.entry
              : createEntry(current, lifetime.signal, validate);

            state = BindingLifecycle.Bound({ entry });
            update({ ...entry, checking: false });
          },
          onFailure: () => {
            if (reading(state)) {
              state = BindingLifecycle.Unavailable();
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
    state = BindingLifecycle.Disposed();
    cancel();
    removeListeners();
  };
};
