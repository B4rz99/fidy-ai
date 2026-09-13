import { DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  Sharding,
} from "effect/unstable/cluster";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { jsonStringSchema } from "~/schema-compatibility";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";
import {
  BrowserPairingEmailDeliveryWorkflow,
  BrowserPairingEmailExpiryWorkflow,
  PairingDeliveryPayload,
  PairingExpiryPayload,
  pairingDeliveryQueueName,
  pairingExpiryQueueName,
  pairingStartQueueName,
} from "./pairing-email-execution";

const CompletedQueueItem = Schema.Struct({
  sequence: Schema.Int,
  id: Schema.String,
  queueName: Schema.Literals([
    pairingStartQueueName,
    pairingDeliveryQueueName,
    pairingExpiryQueueName,
  ]),
  element: Schema.String,
});

const purgeTerminalQueueItem = Effect.fn(function* (row: typeof CompletedQueueItem.Type) {
  const sql = yield* SqlClient.SqlClient;
  const storage = yield* MessageStorage.MessageStorage;
  const sharding = yield* Sharding.Sharding;
  let address = Option.none<EntityAddress.EntityAddress>();
  if (row.queueName !== pairingStartQueueName) {
    const workflow =
      row.queueName === pairingDeliveryQueueName
        ? BrowserPairingEmailDeliveryWorkflow
        : BrowserPairingEmailExpiryWorkflow;
    const executionId =
      row.queueName === pairingDeliveryQueueName
        ? yield* BrowserPairingEmailDeliveryWorkflow.executionId(
            yield* Schema.decodeEffect(jsonStringSchema(PairingDeliveryPayload))(row.element)
          ).pipe(Effect.orDie)
        : yield* BrowserPairingEmailExpiryWorkflow.executionId(
            yield* Schema.decodeEffect(jsonStringSchema(PairingExpiryPayload))(row.element)
          ).pipe(Effect.orDie);
    const terminal =
      row.queueName === pairingDeliveryQueueName
        ? yield* BrowserPairingEmailDeliveryWorkflow.poll(executionId).pipe(
            Effect.map(Option.exists((state) => state._tag === "Complete"))
          )
        : yield* BrowserPairingEmailExpiryWorkflow.poll(executionId).pipe(
            Effect.map(Option.exists((state) => state._tag === "Complete"))
          );
    if (!terminal) return;
    const entityId = EntityId.make(executionId);
    address = Option.some(
      EntityAddress.make({
        entityId,
        entityType: EntityType.make(`Workflow/${workflow._tag}`),
        shardId: sharding.getShardId(entityId, "default"),
      })
    );
  }
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        if (Option.isSome(address)) {
          yield* storage.clearAddress(address.value);
          // DurableClock stores a separate entity under the same execution identity.
          yield* storage.clearAddress(
            EntityAddress.make({
              entityType: EntityType.make("Workflow/-/DurableClock"),
              entityId: address.value.entityId,
              shardId: address.value.shardId,
            })
          );
        }
        yield* sql`DELETE FROM fidy_queue WHERE id = ${row.id} AND queue_name = ${row.queueName} AND completed = TRUE`;
      })
    )
    .pipe(Effect.orDie);
});

/** Removes a bounded page of terminal native history after the authentication replay horizon.
 * Native queue payloads retain identifiers after proof erasure; no cleanup ledger is needed.
 * History and completed queue deletion share the SQL transaction, including crash recovery.
 */
export const purgeBrowserPairingEmailExecutionHistory = Effect.fn(function* (afterSequence = 0) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = DateTime.subtract(yield* DateTime.now, { hours: 24 });
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: CompletedQueueItem,
    execute: () => sql`SELECT sequence, id, queue_name AS "queueName", element FROM fidy_queue
      WHERE sequence > ${afterSequence} AND completed = TRUE AND updated_at < ${cutoff}
        AND queue_name IN (${pairingStartQueueName}, ${pairingDeliveryQueueName}, ${pairingExpiryQueueName})
      ORDER BY sequence LIMIT 100`,
  })(undefined).pipe(Effect.orDie);
  for (const row of rows) yield* purgeTerminalQueueItem(row);
  if (rows.length === 100) {
    yield* Effect.logWarning("Browser pairing email history cleanup has an overdue full page");
  }
  return rows.length === 100 ? Option.getOrThrow(Option.fromNullishOr(rows.at(-1))).sequence : 0;
});

/** Purges one bounded batch of expired anonymous admission evidence. */
export const purgeBrowserPairingEmailAdmissionEvidence = Effect.fn(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  yield* sql`SELECT fidy_purge_email_pairing_login_admission_evidence(${now})`.pipe(Effect.orDie);
});

/** Best-effort bounded evidence/history maintenance, not a domain-expiry polling executor. */
export const BrowserPairingEmailRetentionLive = Layer.effectDiscard(
  Effect.all(
    [
      runBestEffortMaintenance({
        timing: "best-effort",
        cadence: "1 minute",
        work: purgeBrowserPairingEmailAdmissionEvidence(),
      }).pipe(Effect.forkScoped),
      Effect.gen(function* () {
        // This process-local scan cursor provides fairness; it owns no execution or lease.
        const cursor = yield* Ref.make(0);
        return yield* runBestEffortMaintenance({
          timing: "best-effort",
          cadence: "1 minute",
          work: Ref.get(cursor).pipe(
            Effect.flatMap(purgeBrowserPairingEmailExecutionHistory),
            Effect.flatMap((next) => Ref.set(cursor, next)),
            Effect.catchCause(() =>
              Effect.logError("Browser pairing email durable retention failed")
            )
          ),
        });
      }).pipe(Effect.forkScoped),
    ],
    { discard: true }
  )
);
