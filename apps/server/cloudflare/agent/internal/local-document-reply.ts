import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Predicate, Schema } from "effect";
import { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import { TranscriptText } from "../../../src/core/agent/contract";
import { applyTool } from "./local-tool";
import { type LocalTurn } from "./local-turn";
import { liveTurn, propose } from "./local-turn-store";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";

const recheckMs = 1000;

export const waitForDocument = Effect.fn(function* (
  turn: LocalTurn,
  now: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const [waiting] =
    yield* sql`SELECT i.turn_id FROM hosted_whatsapp_inbound i JOIN statement_documents d ON d.user_id=i.user_id AND d.message=i.message AND d.portfolio=i.portfolio LEFT JOIN statement_submissions s ON s.id=d.id AND s.user_id=i.user_id WHERE i.turn_id=${turn.id} AND i.user_id=${turn.user_id} AND i.media_id IS NOT NULL AND d.unsupported=0 AND d.disposition=0 AND (s.id IS NULL OR s.status IN ('queued','processing'))`;

  if (waiting === undefined) return false;
  const next = Math.min(now + recheckMs, turn.deadline_ms);
  yield* sql`UPDATE hosted_whatsapp_inbound SET offer_ms=${next} WHERE turn_id=${turn.id}`;
  yield* preserveStoreAlarm(storage, next);

  return true;
});

const publication = Schema.Struct({
  id: Schema.String,
  byte_length: Schema.Int,
  sha256: Schema.String,
  status: Schema.String,
  record: Schema.OptionFromNullOr(Schema.Int),
});

export const documentReply = Effect.fn(function* (turn: LocalTurn, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const [doc] =
    yield* sql`SELECT d.unsupported,s.id,m.byte_length,m.sha256,s.status,(SELECT min(record_number) FROM ingestion_review_items r WHERE r.user_id=s.user_id AND r.statement_submission_id=s.id AND coalesce(r.workspace_state,'pending')='pending') AS record FROM hosted_whatsapp_inbound i JOIN statement_documents d ON d.user_id=i.user_id AND d.message=i.message AND d.portfolio=i.portfolio LEFT JOIN statement_submissions s ON s.id=d.id AND s.user_id=i.user_id AND s.hosted_turn_id=i.turn_id LEFT JOIN statement_staging_objects m ON m.id=s.staging_id AND m.user_id=s.user_id WHERE i.turn_id=${turn.id} AND i.user_id=${turn.user_id} AND i.media_id IS NOT NULL`;

  if (doc === undefined) return false;
  const now = yield* Clock.currentTimeMillis;
  yield* liveTurn(turn, now);
  let text = TranscriptText.make("No se pudo procesar el archivo adjunto.");

  if (doc.id !== null) {
    const held = yield* Schema.decodeUnknownEffect(publication)(doc);

    const result = yield* applyTool(
      {
        id: "statement-upload:" + turn.id,
        operation: CanonicalOperationId.make("ingestion.submitForExtraction"),
        params: {
          payload: {
            idempotencyKey: held.id,
            reference: { stagingId: held.id, byteLength: held.byte_length, sha256: held.sha256 },
          },
        },
      },
      { turn, iteration: 1, storage }
    );

    if (Predicate.isTagged(result.outcome, "Succeeded") && held.status === "completed") {
      text = Option.match(held.record, {
        onNone: () =>
          TranscriptText.make(
            "El extracto está listo. Las Transacciones capturadas ya son visibles."
          ),
        onSome: (record) =>
          TranscriptText.make(
            `Las Transacciones claras ya son visibles. Para la fila ${record}, indica fecha, importe, moneda y si es entrada o salida. También puedes pedir omitirla o cancelar lo pendiente. No envíes credenciales ni números de cuenta.`
          ),
      });
    }
  }

  yield* preserveStoreAlarm(storage, yield* propose(turn, text, 1));

  return true;
});
