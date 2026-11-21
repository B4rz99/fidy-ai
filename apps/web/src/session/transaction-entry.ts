import { DateTime, type Effect, Option } from "effect";
import { type AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { ProcessingConsentStatus, WebAuthClient } from "@/transport/client";

type ConsentError = Effect.Error<
  ReturnType<WebAuthClient["Service"]["processingConsent"]["status"]>
>;

type ConsentValue = Option.Option<AsyncResult.AsyncResult<ProcessingConsentStatus, ConsentError>>;

export const initialConsentObservation: (
  client: WebAuthClient
) => Atom.Writable<ConsentValue, ConsentValue> = Atom.family((_client: WebAuthClient) =>
  Atom.make<Option.Option<AsyncResult.AsyncResult<ProcessingConsentStatus, ConsentError>>>(
    Option.none()
  ).pipe(Atom.setIdleTTL("400 millis"))
);

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

export const initialTransactionConsent = Atom.make<Option.Option<number>>(Option.none()).pipe(
  Atom.setIdleTTL("400 millis")
);

export const consumeInitialTransactionConsent = (registry: AtomRegistry.AtomRegistry): boolean => {
  const observedAt = registry.get(initialTransactionConsent);
  registry.set(initialTransactionConsent, Option.none());
  const bridgeMilliseconds = 400;

  if (Option.isNone(observedAt)) return false;
  const age = DateTime.toEpochMillis(DateTime.nowUnsafe()) - observedAt.value;

  return age >= 0 && age < bridgeMilliseconds;
};
