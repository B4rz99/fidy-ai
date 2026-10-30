import { Option } from "effect";
import { type AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { ProcessingConsentStatus, WebAuthClient } from "@/transport/client";

export const initialConsentObservation = Atom.family((_client: WebAuthClient) =>
  Atom.make<Option.Option<AsyncResult.AsyncResult<ProcessingConsentStatus, unknown>>>(
    Option.none()
  ).pipe(Atom.setIdleTTL("400 millis"))
);

/** A fresh bootstrap observation can bridge the first entry; every later entry refreshes HTTP. */
export const transactionEntryConsent = Atom.family((client: WebAuthClient) => {
  const remote = client.query("processingConsent", "status", { timeToLive: "400 millis" });
  return Atom.readable(
    (get) => Option.getOrElse(get(initialConsentObservation(client)), () => get(remote)),
    (refresh) => {
      refresh(remote);
      refresh(initialConsentObservation(client));
    }
  ).pipe(
    client.runtime.factory.withReactivity(["processing-consent"]),
    Atom.setIdleTTL("400 millis")
  );
});

/** Consumed once for the actual initial entry, and only within the loader-to-commit interval. */
export const initialTransactionConsent = Atom.make<Option.Option<number>>(Option.none()).pipe(
  Atom.setIdleTTL("400 millis")
);
export const consumeInitialTransactionConsent = (registry: AtomRegistry.AtomRegistry): boolean => {
  const observedAt = registry.get(initialTransactionConsent);
  registry.set(initialTransactionConsent, Option.none());
  const bridgeMilliseconds = 400;
  if (Option.isNone(observedAt)) return false;
  const age = Date.now() - observedAt.value;
  return age >= 0 && age < bridgeMilliseconds;
};
