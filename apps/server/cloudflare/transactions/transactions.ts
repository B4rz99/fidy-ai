import {
  CreateTransactionInput,
  Transaction,
  encodeMoneyAmount,
} from "@fidy/server/transactions-runtime";
import { Cause, Data, DateTime, Effect, Exit, Option, Schema } from "effect";
import {
  livePATAuthority,
  recordCanonicalPATWork,
  recordCapturedPATUse,
} from "@fidy/server/tokens-runtime";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import { transactionCaptureCompletion } from "@fidy/server/transaction-capture";
import { sessionCookie, sha256 } from "../identity/browser-login";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import { decodeTransactionRow } from "./transaction-history";
import type { AuthorizedPAT } from "../pats/pat-authorization";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionSubject,
  transactionNoStore as noStore,
  transactionNow as now,
  refusedPATWork,
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
  transactionFailure({
    code: "unauthenticated",
    status: HTTP_UNAUTHENTICATED,
    message: "Present a valid credential and retry.",
  });
const invalid = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: HTTP_INVALID,
    message: "Invalid Transaction input.",
  });
const missing = (): Response =>
  transactionFailure({
    code: "not_found",
    status: HTTP_NOT_FOUND,
    message: "Transaction unavailable.",
  });
const limited = (): Response =>
  transactionFailure({
    code: "rate_limited",
    status: HTTP_RATE_LIMITED,
    message: "Manual Transaction budget exhausted.",
  });
type Subject = TransactionSubject | AuthorizedPAT;
const isPAT = (subject: Subject): subject is AuthorizedPAT => "patId" in subject;
const refusedCaptureWork = (db: D1Database, subject: Subject): Promise<Response> =>
  isPAT(subject) ? refusedPATWork({ db, userId: subject.userId }) : Promise.resolve(noSession());
type Refusal = "not_found" | "validation_failed" | "resource_limit";

/** Record a rejected authenticated canonical mutation without retaining its body or granting expired sessions access. */
export const rejectManualTransaction = ({
  db,
  subject,
  outcome,
}: {
  db: D1Database;
  subject: Subject;
  outcome: Refusal;
}): Promise<Response> => {
  const current = now();
  return Promise.resolve()
    .then(() => {
      const statement = isPAT(subject)
        ? prepareOwnedStatement({
            db,
            statement: recordCanonicalPATWork({
              subject,
              input: {
                id: uuid(),
                current,
                operation: "transactions.createTransaction",
                outcome: "rejected",
                afterSourceAttestation: false,
              },
            }),
          })
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
            );
      return statement.run();
    })
    .then((audit) => {
      if (audit.meta.changes !== 1) return refusedCaptureWork(db, subject);
      switch (outcome) {
        case "not_found":
          return missing();
        case "validation_failed":
          return invalid();
        case "resource_limit":
          return limited();
      }
    })
    .catch((error: unknown) =>
      String(error).includes("transaction_audit_limit") ? limited() : unavailable()
    );
};
type Capture = Readonly<{
  input: typeof Input.Type;
  subject: Subject;
  context: typeof UserContext.Type;
  id: string;
  current: number;
  auditId: string;
}>;

const sessionSubject = (raw: unknown, digest: Uint8Array): Option.Option<TransactionSubject> =>
  Option.map(Schema.decodeUnknownOption(Session)(raw), (value) => ({
    id: value.id,
    userId: value.user_id,
    digest,
  }));

/** Resolve a live WebSession on every canonical call; neither an object id nor a User id is authority. */
export const transactionSession = ({
  request,
  db,
}: {
  request: Request;
  db: D1Database;
}): Promise<Option.Option<TransactionSubject>> => {
  const cookie = sessionCookie(request);
  if (Option.isNone(cookie)) return Promise.resolve(Option.none());
  return sha256(cookie.value).then((digest) => {
    const current = now();
    return db
      .prepare(
        `SELECT id, user_id FROM web_sessions WHERE token_digest = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
      AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)`
      )
      .bind(digest, current, current)
      .first()
      .then((raw) => sessionSubject(raw, digest));
  });
};

/** Decode bounded canonical input before dispatching a mutation to the User coordinator. */
export const transactionInput = (request: Request): Promise<Option.Option<typeof Input.Type>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Promise.resolve(Option.none());
  }
  return Effect.runPromise(readBoundedRequestBody(request, policy))
    .then((bytes) => {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return Schema.decodeUnknownOption(Input)(parsed);
    })
    .catch(() => Option.none());
};

const captureAudit = (db: D1Database, capture: Capture): D1PreparedStatement => {
  const { subject, id, current, auditId } = capture;
  return isPAT(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: {
            id: auditId,
            current,
            operation: "transactions.createTransaction",
            outcome: "accepted",
            afterSourceAttestation: true,
          },
        }),
      })
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
    ? livePATAuthority({ subject, current })
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
    ...(isPAT(subject)
      ? [
          prepareOwnedStatement({
            db,
            statement: recordCapturedPATUse({
              subject,
              input: { auditId: capture.auditId, current },
            }),
          }),
        ]
      : []),
  ];
};

const hasUnknownCategory = (db: D1Database, categoryId: Option.Option<string>): Promise<boolean> =>
  Option.isNone(categoryId)
    ? Promise.resolve(false)
    : db
        .prepare("SELECT id FROM categories WHERE id = ?")
        .bind(categoryId.value)
        .first()
        .then((category) => category === null);

const classifyCaptureAuthority = (db: D1Database, subject: Subject): Promise<Response> => {
  try {
    const authority = isPAT(subject)
      ? livePATAuthority({ subject, current: now() })
      : liveWebSessionAuthority({ subject, current: now() });
    return db
      .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(...authority.bindings)
      .first()
      .then((live) => (live !== null ? unavailable() : refusedCaptureWork(db, subject)))
      .catch(unavailable);
  } catch {
    return Promise.resolve(unavailable());
  }
};

const failedCapture = (db: D1Database, subject: Subject, error: unknown): Promise<Response> => {
  if (String(error).includes("transaction_resource_limit")) {
    return rejectManualTransaction({ db, subject, outcome: "resource_limit" });
  }
  return String(error).includes("transaction_audit_limit")
    ? Promise.resolve(limited())
    : classifyCaptureAuthority(db, subject);
};

const browserCaptureWrites = 3;
const patCaptureWrites = 4;
const captureCompleted = (results: ReadonlyArray<D1Result>, pat: boolean): boolean => {
  const expectedWrites = pat ? patCaptureWrites : browserCaptureWrites;
  const writes = results.slice(0, expectedWrites);
  return writes.length === expectedWrites && writes.every((result) => result.meta.changes === 1);
};

class TransactionBoundaryFailure extends Data.TaggedError("TransactionBoundaryFailure")<{
  readonly cause: unknown;
}> {}
const waitFor = <A>(run: () => Promise<A>): Effect.Effect<A, TransactionBoundaryFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TransactionBoundaryFailure({ cause }) });

const captureUserContext = (
  db: D1Database,
  userId: string
): Effect.Effect<Option.Option<typeof UserContext.Type>, TransactionBoundaryFailure> =>
  waitFor(() =>
    db
      .prepare("SELECT service_market, locale, time_zone FROM users WHERE id = ?")
      .bind(userId)
      .first()
  ).pipe(Effect.map(Schema.decodeUnknownOption(UserContext)));

const decideCaptureResponse = <E>({
  db,
  subject,
  exit,
}: {
  db: D1Database;
  subject: Subject;
  exit: Exit.Exit<Response | "not_found", E>;
}): Promise<Response> | Response => {
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    return failedCapture(
      db,
      subject,
      Option.isSome(failure) && failure.value instanceof TransactionBoundaryFailure
        ? failure.value.cause
        : Cause.squash(exit.cause)
    );
  }
  return exit.value === "not_found"
    ? rejectManualTransaction({ db, subject, outcome: "not_found" })
    : exit.value;
};

/** Persist one manual Transaction, its captured context and AuditLogEntry in one D1 atomic batch. */
export const createManualTransaction = ({
  db,
  subject,
  input,
}: {
  db: D1Database;
  subject: Subject;
  input: typeof Input.Type;
}): Promise<Response> => {
  const current = now();
  if (DateTime.toEpochMillis(input.occurredAt) > current) {
    return rejectManualTransaction({ db, subject, outcome: "validation_failed" });
  }
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const context = yield* captureUserContext(db, subject.userId);
      if (Option.isNone(context)) return unavailable();
      if (yield* waitFor(() => hasUnknownCategory(db, input.categoryId))) {
        return "not_found" as const;
      }
      const id = uuid();
      const result = yield* waitFor(() =>
        db.batch([
          ...captureStatements(db, {
            input,
            subject,
            context: context.value,
            id,
            current,
            auditId: uuid(),
          }),
          db.prepare(transactionCaptureCompletion),
        ])
      );
      if (!captureCompleted(result, isPAT(subject))) {
        return yield* waitFor(() => refusedCaptureWork(db, subject));
      }
      const raw = yield* waitFor(() =>
        db
          .prepare(`SELECT id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at
      FROM transactions WHERE user_id = ? AND id = ?`)
          .bind(subject.userId, id)
          .first()
      );
      const stored = decodeTransactionRow(raw);
      if (Option.isNone(stored)) return unavailable();
      return Response.json(
        { data: yield* Schema.encodeEffect(Output)(stored.value), next: [] },
        { status: 201, headers: noStore }
      );
    })
  )
    .then((exit) => decideCaptureResponse({ db, subject, exit }))
    .catch(() => unavailable());
};

export { noSession as unauthenticatedTransaction, unavailable as unavailableTransaction };
