import { BudgetThresholdEvaluation } from "../../budgets/contract";
import { commitLocalWrite, prepareLocalWrite } from "../../canonical-admission/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import type { CreateTransactionInput } from "../../../src/core/transactions/contract";
import { resolveLocalCategory, retainLocalCategory } from "../../categories/operations";
import { newId } from "../../secret-material/operations";
import {
  CanonicalAdmissionUnavailable,
  type LocalMutationResult,
} from "../../canonical-admission/contract";
import { TransactionOutput, decodeTransactionRow } from "./transaction-history";

const invalidStatus = 400;

const missingStatus = 404;

export const localTransactionRefusal = ({
  status,
  code,
  message,
}: Readonly<{
  status: number;
  code: "not_found" | "validation_failed";
  message: string;
}>): LocalMutationResult => ({
  status,
  outcome: code,
  body: {
    error: code === "validation_failed" ? { code, message, fields: [] } : { code, message },
    next: [],
  },
});

const captureDecisionKeys = (input: CreateTransactionInput): ReadonlyArray<string> => [
  "money",
  "direction",
  "occurredAt",
  ...Option.match(input.categoryId, { onNone: () => [], onSome: () => ["categoryId"] }),
  ...Option.match(input.counterparty, { onNone: () => [], onSome: () => ["counterparty"] }),
  ...Option.match(input.notes, { onNone: () => [], onSome: () => ["notes"] }),
];

type CaptureSource = Readonly<{ context: UserContext; revision: string }> &
  (
    | { kind: "manual"; reviewId: string }
    | {
        kind: "statement-line";
        submissionId: string;
        recordNumber: number;
        sha256: string;
        format: string;
      }
    | {
        kind: "notification-email";
        receiptId: string;
        sha256: string;
        format: string;
        interpretation: string;
      }
  );

const sourceFields = Effect.fnUntraced(function* (
  source: Option.Option<CaptureSource>,
  input: CreateTransactionInput
) {
  if (Option.isNone(source)) return {};
  const value = source.value;

  switch (value.kind) {
    case "manual":
      return {
        review_item_id: value.reviewId,
        user_provided_fields: yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Array(Schema.String))
        )(captureDecisionKeys(input)),
      };
    case "statement-line":
      return {
        statement_submission_id: value.submissionId,
        statement_record_number: value.recordNumber,
        content_sha256: value.sha256,
        source_format: value.format,
      };
    case "notification-email":
      return {
        received_email_id: value.receiptId,
        content_sha256: value.sha256,
        source_format: value.format,
        interpretation_json: value.interpretation,
      };
  }
});

const captureReadback = Effect.fn(function* (userId: UserId, id: string, current: number) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT * FROM transaction_effective_source WHERE user_id=${userId} AND id=${id}`;

  const decoded = decodeTransactionRow(row);

  if (Option.isNone(decoded)) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "capture_readback" });
  }

  const data = yield* Schema.encodeEffect(TransactionOutput)(decoded.value);
  yield* (yield* BudgetThresholdEvaluation)(userId, current);

  return { status: 201, outcome: "success" as const, body: { data, next: [] } };
});

const captureProvenance = (
  source: Option.Option<CaptureSource>,
  movementId: Option.Option<string>
): { kind: string; revision: string } =>
  Option.getOrElse(
    Option.map(source, (value) => ({ kind: value.kind, revision: value.revision })),
    () =>
      Option.isNone(movementId)
        ? { kind: "manual" as const, revision: "manual-v1" }
        : { kind: "connection-movement" as const, revision: "connection-v1" }
  );

const prepareCapture = Effect.fn(function* (
  input: CreateTransactionInput,
  {
    userId,
    current,
    movementId,
  }: { userId: UserId; current: number; movementId: Option.Option<string> },
  source: Option.Option<CaptureSource>
) {
  const occurredAt = DateTime.toEpochMillis(input.occurredAt);

  if (occurredAt > current) {
    return localTransactionRefusal({
      status: invalidStatus,
      code: "validation_failed",
      message: "A Transaction cannot occur in the future.",
    });
  }

  const sql = yield* SqliteClient;

  const [owner] =
    yield* sql`SELECT service_market AS serviceMarket,locale,time_zone AS timeZone FROM users WHERE id=${userId}`;

  const context = Option.isSome(source)
    ? source.value.context
    : yield* Schema.decodeUnknownEffect(UserContext)(owner);

  const { kind, revision } = captureProvenance(source, movementId);
  const evidence = yield* sourceFields(source, input);

  const reference = yield* resolveLocalCategory({
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
    return localTransactionRefusal({
      status: missingStatus,
      code: "not_found",
      message: "The Category does not exist; correct categoryId and retry.",
    });
  }

  return prepareLocalWrite({
    targets: [],
    commit: Effect.gen(function* () {
      yield* retainLocalCategory(reference.value);
      const id = Option.getOrElse(movementId, newId);
      yield* sql`INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,category_revision,notes,occurred_at_ms,created_at_ms,user_decisions)
    VALUES (${id},${userId},${encodeMoneyAmount(input.money.amount)},${input.money.currency},${input.direction},${Option.getOrNull(input.counterparty)},${reference.value.categoryId},${reference.value.revision},${Option.getOrNull(input.notes)},${occurredAt},${current},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)))(kind === "manual" ? Object.fromEntries(captureDecisionKeys(input).map((key) => [key, true])) : {})})`;

      const sources =
        yield* sql`INSERT INTO source_attestations ${sql.insert({ id: newId(), user_id: userId, transaction_id: id, kind, service_market: context.serviceMarket, locale: context.locale, time_zone: context.timeZone, interpretation_revision: revision, created_at_ms: current, ...evidence })} RETURNING id`;

      if (sources.length !== 1) {
        return yield* new CanonicalAdmissionUnavailable({ cause: "capture_source" });
      }

      return yield* captureReadback(userId, id, current);
    }),
  });
});

export const prepareLocalCapture = Effect.fnUntraced(function* (
  input: CreateTransactionInput,
  userId: UserId,
  current: number
) {
  return yield* prepareCapture(
    input,
    { userId, current, movementId: Option.none() },
    Option.none()
  );
});

export const prepareSourcedCapture = Effect.fnUntraced(function* (
  input: CreateTransactionInput,
  owner: { userId: UserId; current: number },
  source: CaptureSource
) {
  return yield* prepareCapture(input, { ...owner, movementId: Option.none() }, Option.some(source));
});

export const captureLocalTransaction = Effect.fnUntraced(function* (
  input: CreateTransactionInput,
  user: UserId,
  current: number
) {
  return yield* prepareLocalCapture(input, user, current).pipe(Effect.flatMap(commitLocalWrite));
});

export const prepareConnectionMovement = Effect.fn(function* (
  input: CreateTransactionInput,
  owner: { userId: UserId; current: number; movementId: string }
) {
  return yield* prepareCapture(
    input,
    { ...owner, movementId: Option.some(owner.movementId) },
    Option.none()
  );
});
