import { Effect, Layer } from "effect";
import { expireDuePATPairings } from "./pat-pairing";

/** Scheduling adapter for the PATPairing module's bounded expiry workflow. */
export const PATPairingExpiryWorkerLive = Layer.effectDiscard(
  expireDuePATPairings().pipe(
    Effect.withSpan("PATPairing.expireDue"),
    Effect.delay("1 minute"),
    Effect.forever,
    Effect.forkScoped
  )
);
