import { Effect, Layer } from "effect";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";
import { expireDuePATPairings } from "./pat-pairing";

/** Best-effort PATPairing lifecycle and evidence maintenance; claim enforces expiry itself. */
export const PATPairingMaintenanceLive = Layer.effectDiscard(
  runBestEffortMaintenance({
    timing: "best-effort",
    cadence: "1 minute",
    work: expireDuePATPairings().pipe(Effect.withSpan("PATPairing.expireDue")),
  }).pipe(Effect.forkScoped)
);
