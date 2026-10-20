import { sealRecoveryCase } from "./sealed-case";
import { requireInventory } from "./inventory";
import { checkpointHeldRecords, importHeldRecords } from "./held-records";
import { importOriginalLocators } from "./restore-case";
import { settleExternal } from "./external";
import { Clock, Effect } from "effect";
import { type ErasureScope, ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureExecution } from "../contract";
import { checkpoint } from "./checkpoint";
import { dispose } from "./disposition";
import { seal } from "./draining";

const transition = (
  input: ErasureExecution &
    Readonly<{
      scope: ErasureScope;
      from: "Archiving" | "Erasing";
    }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.flatMap(Clock.currentTimeMillis, (current) =>
    Effect.tryPromise({
      try: () =>
        input.db.batch([
          input.db
            .prepare(
              "UPDATE erasure_requests SET state=?,last_erased_at_ms=CASE WHEN ?='Erasing' THEN ? ELSE last_erased_at_ms END WHERE id=? AND user_id=? AND state=?"
            )
            .bind(
              input.from === "Archiving" ? "Erasing" : "ExternalPending",
              input.from,
              current,
              input.scope.reference,
              input.scope.userId,
              input.from
            ),
          input.db
            .prepare(
              "UPDATE erasure_custody_records SET state='Pending',current_event_id=NULL WHERE record_type='current' AND request_id=? AND custodian='Cloudflare' AND ?='Erasing' AND changes()>0"
            )
            .bind(input.scope.reference, input.from),
        ]),
      catch: () => new ErasureUnavailable(),
    })
  ).pipe(Effect.asVoid);
const prepareDisposition = (
  input: ErasureExecution & Readonly<{ scope: ErasureScope }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (!(yield* importOriginalLocators({ configuration: input.recovery, scope: input.scope }))) {
      return;
    }
    if (!(yield* importHeldRecords({ configuration: input.recovery, scope: input.scope }))) return;
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
    if (
      (yield* input.originals.capture(input.scope)) &&
      (yield* input.originals.checkpoint(input.scope))
    ) {
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
                "UPDATE erasure_requests SET state='Archiving',marker_written=1 WHERE id=? AND user_id=? AND state='Sealing' AND restoring=1 AND restore_objects_done=1"
              )
              .bind(input.scope.reference, input.scope.userId)
              .run(),
          catch: () => new ErasureUnavailable(),
        });
      } else yield* checkpoint({ configuration: input.recovery, scope: input.scope });
    }
  });

export const progress = (
  input: ErasureExecution &
    Readonly<{
      scope: ErasureScope;
      phase: string;
    }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* requireInventory(input);
    if (input.phase === "Draining") return yield* seal(input);
    if (input.phase === "Sealing") return yield* prepareDisposition(input);
    if (input.phase === "ExternalPending") return yield* settleExternal(input);
    if (input.phase !== "Archiving" && input.phase !== "Erasing") return;
    if (input.phase === "Archiving" && !(yield* input.originals.archive(input.scope))) return;
    yield* disposeLive({ ...input, phase: input.phase });
  });

const disposeLive = (
  input: ErasureExecution & Readonly<{ scope: ErasureScope; phase: "Archiving" | "Erasing" }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const finished = yield* dispose({ ...input, phase: input.phase });
    if (!finished) return;
    if (
      input.phase === "Archiving" &&
      !(yield* checkpointHeldRecords({ configuration: input.recovery, scope: input.scope }))
    ) {
      return;
    }
    if (input.phase === "Erasing" && (yield* input.originals.discard(input.scope)) !== "Done") {
      return;
    }
    if (input.phase === "Erasing") {
      yield* Effect.tryPromise({
        try: () =>
          input.db
            .prepare(
              "DELETE FROM erasure_writers WHERE user_id=? AND EXISTS(SELECT 1 FROM erasure_requests WHERE id=? AND user_id=? AND state='Erasing')"
            )
            .bind(input.scope.userId, input.scope.reference, input.scope.userId)
            .run(),
        catch: () => new ErasureUnavailable(),
      });
    }
    yield* transition({ ...input, from: input.phase });
  });
