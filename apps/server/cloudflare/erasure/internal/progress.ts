import { sealRecoveryCase } from "./sealed-case";
import { requireInventory } from "./inventory";
import { settleExternal } from "./external";
import { Clock, Effect } from "effect";
import { type ErasureScope, ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureExecution } from "../contract";
import { checkpoint } from "./checkpoint";
import { dispose } from "./disposition";
import { seal } from "./draining";

const prepareDeletion = (
  input: ErasureExecution & Readonly<{ scope: ErasureScope }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (!(yield* input.clearCoordinator())) return;
    yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(
            "UPDATE erasure_requests SET coordinator_cleared=1 WHERE id=? AND user_id=? AND state='Sealing'"
          )
          .bind(input.scope.reference, input.scope.userId)
          .run(),
      catch: () => new ErasureUnavailable(),
    });
    const restoring = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare("SELECT restoring FROM erasure_requests WHERE id=? AND user_id=?")
          .bind(input.scope.reference, input.scope.userId)
          .first<number>("restoring"),
      catch: () => new ErasureUnavailable(),
    });
    if (restoring === 1) {
      yield* sealRecoveryCase({ configuration: input.recovery, scope: input.scope });
      yield* Effect.tryPromise({
        try: () =>
          input.db
            .prepare(
              "UPDATE erasure_requests SET state='Erasing',marker_written=1 WHERE id=? AND user_id=? AND state='Sealing' AND restoring=1 AND coordinator_cleared=1"
            )
            .bind(input.scope.reference, input.scope.userId)
            .run(),
        catch: () => new ErasureUnavailable(),
      });
    } else yield* checkpoint({ configuration: input.recovery, scope: input.scope });
  });
export const progress = (
  input: ErasureExecution & Readonly<{ scope: ErasureScope; phase: string }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* requireInventory(input);
    if (input.phase === "Draining") return yield* seal(input);
    if (input.phase === "Sealing") return yield* prepareDeletion(input);
    if (input.phase === "ExternalPending") return yield* settleExternal(input);
    if (input.phase !== "Erasing") return;
    if (!(yield* dispose({ ...input, phase: "Erasing" }))) return;
    if ((yield* input.originals.discard(input.scope)) !== "Done") return;
    const current = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise({
      try: () =>
        input.db.batch([
          input.db
            .prepare(
              "UPDATE erasure_requests SET state='ExternalPending',last_erased_at_ms=? WHERE id=? AND user_id=? AND state='Erasing' AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=erasure_requests.user_id)"
            )
            .bind(current, input.scope.reference, input.scope.userId),
          input.db
            .prepare(
              "UPDATE erasure_custody_records SET state='Pending',current_event_id=NULL WHERE record_type='current' AND request_id=? AND custodian='Cloudflare' AND changes()>0"
            )
            .bind(input.scope.reference),
        ]),
      catch: () => new ErasureUnavailable(),
    });
  });
