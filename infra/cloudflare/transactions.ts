import {
  CreateTransactionInput,
  Transaction,
  encodeMoneyAmount,
} from "@fidy/server/transactions-runtime";
import { DateTime, Effect, Option, Schema } from "effect";
import { livePATAuthority, recordCanonicalPATWork } from "@fidy/server/tokens-runtime";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import { transactionCaptureCompletion } from "@fidy/server/transaction-capture";
import { sessionCookie, sha256 } from "./browser-login";
import { RequestBodyPolicy, readBoundedRequestBody } from "./request-body";
import { decodeTransactionRow } from "./transaction-history";
import type { AuthorizedPAT } from "./pat-authorization";
import { prepareOwnedStatement } from "./pat-unit";
import {
  type TransactionSubject,
  transactionNoStore as noStore,
  transactionNow as now,
  transactionFailure,
  transactionUnavailable as unavailable,
  transactionId as uuid,
} from "./transaction-boundary";

const Input = Schema.toCodecJson(CreateTransactionInput);
const Output = Schema.toCodecJson(Transaction);
const UserContext = Schema.Struct({
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
});
const Session = Schema.Struct({ id: Schema.String, user_id: Schema.String });
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 4096,
  deadlineMilliseconds: 2000,
});
const HTTP_UNAUTHENTICATED = 401;
const HTTP_INVALID = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_RATE_LIMITED = 429;
const noSession = (): Response =>
  transactionFailure(
    "unauthenticated",
    HTTP_UNAUTHENTICATED,
    "Present a valid credential and retry."
  );
const invalid = (): Response =>
  transactionFailure("validation_failed", HTTP_INVALID, "Invalid Transaction input.");
const missing = (): Response =>
  transactionFailure("not_found", HTTP_NOT_FOUND, "Transaction unavailable.");
const limited = (): Response =>
  transactionFailure("rate_limited", HTTP_RATE_LIMITED, "Manual Transaction budget exhausted.");
type Subject = TransactionSubject | AuthorizedPAT;
const isPAT = (subject: Subject): subject is AuthorizedPAT => "patId" in subject;
type Refusal = "not_found" | "validation_failed" | "resource_limit";

/** Record a rejected authenticated canonical mutation without retaining its body or granting expired sessions access. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const rejectManualTransaction = async (
  db: D1Database,
  subject: Subject,
  outcome: Refusal
): Promise<Response> => {
  const current = now();
  try {
    const audit = await (
      isPAT(subject)
        ? prepareOwnedStatement(
            db,
            recordCanonicalPATWork(subject, {
              id: uuid(),
              current,
              operation: "transactions.createTransaction",
              outcome: "rejected",
              afterSourceAttestation: false,
            })
          )
        : db
            .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
          SELECT ?, user_id, id, 'transactions.createTransaction', ?, ? FROM web_sessions WHERE id = ? AND user_id = ?
          AND token_digest = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
          AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)`)
            .bind(
              uuid(),
              outcome,
              current,
              subject.id,
              subject.userId,
              subject.digest,
              current,
              current
            )
    ).run();
    if (audit.meta.changes !== 1) return noSession();
    switch (outcome) {
      case "not_found":
        return missing();
      case "validation_failed":
        return invalid();
      case "resource_limit":
        return limited();
    }
  } catch (error) {
    return String(error).includes("transaction_audit_limit") ? limited() : unavailable();
  }
};
type Capture = Readonly<{
  input: typeof Input.Type;
  subject: Subject;
  context: typeof UserContext.Type;
  id: string;
  current: number;
}>;

/** Resolve a live WebSession on every canonical call; neither an object id nor a User id is authority. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const transactionSession = async (
  request: Request,
  db: D1Database
): Promise<Option.Option<TransactionSubject>> => {
  const cookie = sessionCookie(request);
  if (Option.isNone(cookie)) {
    return Option.none();
  }
  const digest = await sha256(cookie.value);
  const current = now();
  const raw = await db
    .prepare(
      `SELECT id, user_id FROM web_sessions WHERE token_digest = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
      AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)`
    )
    .bind(digest, current, current)
    .first();
  const session = Schema.decodeUnknownOption(Session)(raw);
  return Option.map(session, (value) => ({ id: value.id, userId: value.user_id, digest }));
};

/** Decode bounded canonical input before dispatching a mutation to the User coordinator. */
// @effect-diagnostics-next-line asyncFunction:off
export const transactionInput = async (
  request: Request
): Promise<Option.Option<typeof Input.Type>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Option.none();
  }
  try {
    const bytes = await Effect.runPromise(readBoundedRequestBody(request, policy));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return Schema.decodeUnknownOption(Input)(parsed);
  } catch {
    return Option.none();
  }
};

const captureAudit = (db: D1Database, capture: Capture): D1PreparedStatement => {
  const { subject, id, current } = capture;
  return isPAT(subject)
    ? prepareOwnedStatement(
        db,
        recordCanonicalPATWork(subject, {
          id: uuid(),
          current,
          operation: "transactions.createTransaction",
          outcome: "accepted",
          afterSourceAttestation: true,
        })
      )
    : db
        .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, ?, 'transactions.createTransaction', 'success', ? FROM transactions WHERE user_id = ? AND id = ?
        AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = transactions.user_id)
        AND changes() = 1`)
        .bind(uuid(), subject.id, current, subject.userId, id);
};

const captureStatements = (db: D1Database, capture: Capture): Array<D1PreparedStatement> => {
  const { input, subject, context, id, current } = capture;
  const categoryId = Option.getOrElse(input.categoryId, () =>
    Schema.decodeSync(Transaction.fields.categoryId)(
      input.direction === "inflow"
        ? "10000000-0000-4000-8000-000000000015"
        : "10000000-0000-4000-8000-000000000016"
    )
  );
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(current));
  const authority = isPAT(subject)
    ? livePATAuthority(subject, current)
    : {
        table: "web_sessions",
        predicate:
          "id = ? AND user_id = ? AND token_digest = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ? AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)",
        bindings: [subject.id, subject.userId, subject.digest, current, current],
      };
  return [
    db
      .prepare(`INSERT INTO transactions (id, user_id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at)
      SELECT ?, user_id, ?, ?, ?, ?, ?, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(
        id,
        encodeMoneyAmount(input.money.amount),
        input.money.currency,
        input.direction,
        Option.getOrNull(input.counterparty),
        categoryId,
        Option.getOrNull(input.notes),
        DateTime.formatIso(input.occurredAt),
        createdAt,
        ...authority.bindings
      ),
    db
      .prepare(`INSERT INTO source_attestations (id, user_id, transaction_id, kind, service_market, locale, time_zone, interpretation_revision, created_at)
      SELECT ?, user_id, id, 'manual', ?, ?, ?, 'manual-v1', ? FROM transactions WHERE user_id = ? AND id = ?`)
      .bind(
        uuid(),
        context.service_market,
        context.locale,
        context.time_zone,
        createdAt,
        subject.userId,
        id
      ),
    captureAudit(db, capture),
  ];
};

// @effect-diagnostics-next-line asyncFunction:off
const hasUnknownCategory = async (
  db: D1Database,
  categoryId: Option.Option<string>
): Promise<boolean> => {
  if (Option.isNone(categoryId)) return false;
  const category = await db
    .prepare("SELECT id FROM categories WHERE id = ?")
    .bind(categoryId.value)
    .first();
  return category === null;
};

// @effect-diagnostics-next-line asyncFunction:off
const classifyCaptureAuthority = async (db: D1Database, subject: Subject): Promise<Response> => {
  try {
    const authority = isPAT(subject)
      ? livePATAuthority(subject, now())
      : liveWebSessionAuthority(subject, now());
    const live = await db
      .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(...authority.bindings)
      .first();
    return live === null ? noSession() : unavailable();
  } catch {
    return unavailable();
  }
};

const failedCapture = (db: D1Database, subject: Subject, error: unknown): Promise<Response> => {
  if (String(error).includes("transaction_resource_limit")) {
    return rejectManualTransaction(db, subject, "resource_limit");
  }
  return String(error).includes("transaction_audit_limit")
    ? Promise.resolve(limited())
    : classifyCaptureAuthority(db, subject);
};

const captureCompleted = (results: ReadonlyArray<D1Result>): boolean =>
  results[0]?.meta.changes === 1 &&
  results[1]?.meta.changes === 1 &&
  results[2]?.meta.changes === 1;

/** Persist one manual Transaction, its captured context and AuditLogEntry in one D1 atomic batch. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const createManualTransaction = async (
  db: D1Database,
  subject: Subject,
  input: typeof Input.Type
): Promise<Response> => {
  const current = now();
  if (DateTime.toEpochMillis(input.occurredAt) > current) {
    return rejectManualTransaction(db, subject, "validation_failed");
  }
  try {
    const contextRaw = await db
      .prepare("SELECT service_market, locale, time_zone FROM users WHERE id = ?")
      .bind(subject.userId)
      .first();
    const context = Schema.decodeUnknownOption(UserContext)(contextRaw);
    if (Option.isNone(context)) {
      return unavailable();
    }
    if (await hasUnknownCategory(db, input.categoryId)) {
      return rejectManualTransaction(db, subject, "not_found");
    }
    const id = uuid();
    const result = await db.batch([
      ...captureStatements(db, { input, subject, context: context.value, id, current }),
      db.prepare(transactionCaptureCompletion),
    ]);
    if (!captureCompleted(result)) {
      return noSession();
    }
    const raw = await db
      .prepare(`SELECT id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at
      FROM transactions WHERE user_id = ? AND id = ?`)
      .bind(subject.userId, id)
      .first();
    const stored = decodeTransactionRow(raw);
    if (Option.isNone(stored)) {
      return unavailable();
    }
    return Response.json(
      { data: Schema.encodeSync(Output)(stored.value), next: [] },
      { status: 201, headers: noStore }
    );
  } catch (error) {
    return failedCapture(db, subject, error);
  }
};

export { noSession as unauthenticatedTransaction, unavailable as unavailableTransaction };
