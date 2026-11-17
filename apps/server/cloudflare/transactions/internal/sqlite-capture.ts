import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import type { CreateTransactionInput } from "../../../src/core/transactions/contract";
import { categorizeLocalCapture } from "../../categories/operations";
import { newId } from "../../secret-material/operations";
import {
  CanonicalAdmissionUnavailable,
  type LocalMutationResult,
} from "../../canonical-admission/contract";
import { TransactionOutput, decodeTransactionRow } from "./transaction-history";

const invalidStatus = 400;
const missingStatus = 404;
const refusal = (
  status: number,
  code: "not_found" | "validation_failed",
  message: string
): LocalMutationResult => ({
  status,
  outcome: code,
  body: {
    error: { code, message, ...(code === "validation_failed" ? { fields: [] } : {}) },
    next: [],
  },
});

/** Compose the movement, provenance and history read model into the caller's protected SQLite transaction. */
export const captureLocalTransaction = Effect.fn(function* (
  input: CreateTransactionInput,
  userId: UserId,
  current: number
) {
  const occurredAt = DateTime.toEpochMillis(input.occurredAt);
  if (occurredAt > current) {
    return refusal(invalidStatus, "validation_failed", "A Transaction cannot occur in the future.");
  }
  const sql = yield* SqliteClient;
  const [owner] =
    yield* sql`SELECT service_market AS serviceMarket,locale,time_zone AS timeZone FROM users WHERE id=${userId}`;
  const context = yield* Schema.decodeUnknownEffect(UserContext)(owner);
  const reference = yield* categorizeLocalCapture({
    userId,
    capture: {
      caller: input.categoryId,
      direction: input.direction,
      counterparty: input.counterparty,
    },
  }).pipe(
    Effect.asSome,
    Effect.catchTag("CategoryNotFound", () => Effect.succeedNone)
  );
  if (Option.isNone(reference)) {
    return refusal(
      missingStatus,
      "not_found",
      "The Category does not exist; correct categoryId and retry."
    );
  }
  const id = newId();
  const facts = {
    money: true,
    direction: true,
    occurredAt: true,
    ...(Option.isSome(input.categoryId) ? { categoryId: true } : {}),
    ...(Option.isSome(input.counterparty) ? { counterparty: true } : {}),
    ...(Option.isSome(input.notes) ? { notes: true } : {}),
  };
  yield* sql`INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,category_revision,notes,occurred_at_ms,created_at_ms,user_decisions)
    VALUES (${id},${userId},${encodeMoneyAmount(input.money.amount)},${input.money.currency},${input.direction},${Option.getOrNull(input.counterparty)},${reference.value.categoryId},${reference.value.revision},${Option.getOrNull(input.notes)},${occurredAt},${current},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)))(facts)})`;
  const sources =
    yield* sql`INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms)
    VALUES (${newId()},${userId},${id},'manual',${context.serviceMarket},${context.locale},${context.timeZone},'manual-v1',${current}) RETURNING id`;
  if (sources.length !== 1) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "capture_source" });
  }
  yield* sql`INSERT INTO transaction_projection_leaf(user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision)
     SELECT user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision FROM transactions
     WHERE user_id=${userId} AND id=${id} AND EXISTS(SELECT 1 FROM transaction_projection_state WHERE user_id=${userId} AND readiness='ready')`;
  const [row] =
    yield* sql`SELECT * FROM transaction_effective_source WHERE user_id=${userId} AND id=${id}`;
  const decoded = decodeTransactionRow(row);
  if (Option.isNone(decoded)) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "capture_readback" });
  }
  const data = yield* Schema.encodeEffect(TransactionOutput)(decoded.value);
  return { status: 201, outcome: "success" as const, body: { data, next: [] } };
});
