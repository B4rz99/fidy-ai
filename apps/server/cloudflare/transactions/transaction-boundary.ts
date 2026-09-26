import { Clock, Data, Effect, Option, Schema } from "effect";
import type { CanonicalCapability, ErrorCode } from "@fidy/server/canonical-runtime";
import { type WebSessionAuthority, liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import {
  type AuditedPATMutation,
  type PATAuthority,
  livePATAuthority,
  livePATCredential,
  recordAuditedPATUseFromAuthority,
  recordCanonicalPATWork,
  recordCanonicalPATWorkFromAuthority,
} from "@fidy/server/tokens-runtime";
import type { AuthorizedPAT } from "../pats/pat-authorization";
import { prepareOwnedStatement } from "../pats/pat-unit";
import { newId } from "../pats/pat-shared";
import { refusedByAuditBudget } from "../audit/audit-triggers";

/**
 * How one decided refusal was durably handled. `"recorded"` means the refusal stands and the
 * response follows from it, whether or not the owner keeps a refusal AuditLogEntry; the other
 * values name the cause that denied the durable record instead. `recordTransactionRefusal`
 * returns it, and it is the only answer a refusal Audit row can give.
 */
export type CanonicalRefusalDisposition =
  | "recorded"
  | "credential_refused"
  | "rate_limited"
  | "unavailable";

/** A Transaction adapter dependency failure whose kind is classified and never exposed. */
export class TransactionBoundaryFailure extends Data.TaggedError("TransactionBoundaryFailure")<{
  readonly cause: unknown;
}> {}
/** Wrap one rejected dependency promise so the failure channel stays typed. */
export const boundaryFailure = (cause: unknown): TransactionBoundaryFailure =>
  new TransactionBoundaryFailure({ cause });
/** Shared, request-scoped identity and safe response vocabulary for the D1 Transaction adapters. */
export type TransactionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;
/** The two live caller subjects that may execute Transaction work. */
export type TransactionCaller = TransactionSubject | AuthorizedPAT;
/** True when the caller is an authorized PAT rather than a WebSession. */
export const isPATCaller = (subject: TransactionCaller): subject is AuthorizedPAT =>
  "patId" in subject;
/** The exact PAT capability a caller operates under; a WebSession carries none. */
export const callerScope = (subject: TransactionCaller): Option.Option<CanonicalCapability> =>
  isPATCaller(subject) ? subject.requiredScope : Option.none();
/** Restore the exact authority one canonical child is executed and audited under: a PAT scope. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const childCaller = (
  subject: TransactionCaller,
  requiredScope: Option.Option<CanonicalCapability>
): TransactionCaller =>
  isPATCaller(subject) && Option.isSome(requiredScope) ? { ...subject, requiredScope } : subject;
export const transactionNow = (): number => Effect.runSync(Clock.currentTimeMillis);
export const transactionId = (): string => newId();
export const transactionNoStore = { "cache-control": "no-store" };
/** One canonical Transaction input is bounded by this many bytes, for every adapter that reads one. */
export const maximumTransactionInputBytes = 4096;
/** The message `transactions.getTransaction` and corrections share for an absent or foreign id. */
export const missingTransactionMessage = "Transaction unavailable.";
/** The message every adapter shares for an input that fails its canonical schema. */
export const invalidTransactionMessage = "Invalid Transaction input.";
/** The message both pair entry points share when the pair cannot describe one purchase. */
export const pairPolicyMessage =
  "Only two different Transactions with equal Currency, exact amount, and the same direction can describe one purchase.";
/** The message both pair entry points share when either member is already linked. */
export const alreadyLinkedMessage =
  "One of the Transactions is already linked to another Transaction.";
/** The message both pair entry points share when the exact pair is not currently linked. */
export const unlinkedPairMessage = "That exact Transaction pair is not currently linked.";
/** The closed state of one Reconciliation decision row, exactly as the 0013 migration constrains it. */
export const ReconciliationDecisionRow = Schema.Struct({
  state: Schema.Literals(["linked", "keep-separate"]),
});

/** The canonical mutations this adapter executes, individually or as children of one batch. */
export type TransactionMutationOperation =
  | "transactions.createTransaction"
  | "transactions.updateTransaction"
  | "transactions.linkTransactions"
  | "transactions.unlinkTransactions";

/**
 * Why one canonical Transaction mutation was refused without changing domain state. The outcome is
 * the metadata-only rejection Audit either an individual call or a batch child reports; `message`
 * is addressed to the calling agent and never carries input bodies or database detail.
 */
export type TransactionRefusal = Readonly<{
  outcome: "not_found" | "validation_failed" | "resource_limit";
  message: string;
}>;

/**
 * One accepted canonical PAT AuditLogEntry and the PAT use it accounts for, in the guard-chained
 * order the unit requires: the AuditLogEntry immediately follows the owner write it attests
 * (`afterOwnerWrite`), and the PAT use immediately follows the AuditLogEntry that accounts for it.
 * One minted audit identity binds the pair. This is the one place the pairing is decided, so every
 * canonical unit that commits a PAT call — a Transaction batch child or a statement publication —
 * orders and accounts for it the same way.
 */
export const acceptedPATAccountability = ({
  afterOwnerWrite,
  authority,
  current,
  database,
  operation,
}: Readonly<{
  afterOwnerWrite: boolean;
  authority: PATAuthority;
  current: number;
  database: D1Database;
  operation: AuditedPATMutation;
}>): ReadonlyArray<D1PreparedStatement> => {
  const auditId = newId();
  return [
    prepareOwnedStatement({
      db: database,
      statement: recordCanonicalPATWorkFromAuthority({
        authority,
        input: { afterOwnerWrite, current, id: auditId, operation, outcome: "accepted" },
      }),
    }),
    prepareOwnedStatement({
      db: database,
      statement: recordAuditedPATUseFromAuthority({
        authority,
        input: { auditId, current, operation },
      }),
    }),
  ];
};

/** The same accepted pair for a caller admitted as a subject rather than as a held authority. */
export const acceptedPATStatements = ({
  db,
  subject,
  operation,
  current,
}: Readonly<{
  db: D1Database;
  subject: AuthorizedPAT;
  operation: TransactionMutationOperation;
  current: number;
}>): ReadonlyArray<D1PreparedStatement> =>
  acceptedPATAccountability({
    afterOwnerWrite: true,
    authority: livePATAuthority({ subject, current }),
    current,
    database: db,
    operation,
  });

const refusalStatement = ({
  db,
  subject,
  outcome,
  operation,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  outcome: TransactionRefusal["outcome"];
  operation: TransactionMutationOperation;
  current: number;
}>): D1PreparedStatement =>
  isPATCaller(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: {
            id: transactionId(),
            current,
            operation,
            outcome: "rejected",
            afterOwnerWrite: false,
          },
        }),
      })
    : sessionRefusalStatement({ db, subject, outcome, operation, current });

const sessionRefusalStatement = ({
  db,
  subject,
  outcome,
  operation,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  outcome: TransactionRefusal["outcome"];
  operation: TransactionMutationOperation;
  current: number;
}>): D1PreparedStatement => {
  const authority = liveWebSessionAuthority({ subject, current });
  return db
    .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
      SELECT ?, user_id, id, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
    .bind(transactionId(), operation, outcome, current, ...authority.bindings);
};

/**
 * Record one refused Transaction mutation's metadata-only AuditLogEntry. A refusal whose audit
 * cannot commit for a dead credential, an exhausted shared daily budget, or a database defect is
 * reported as that cause instead: the caller never reports a refusal the durable record denies.
 */
export const recordTransactionRefusal = ({
  db,
  subject,
  outcome,
  operation,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  outcome: TransactionRefusal["outcome"];
  operation: TransactionMutationOperation;
  current: number;
}>): Promise<CanonicalRefusalDisposition> =>
  Promise.resolve()
    .then(() => refusalStatement({ db, subject, outcome, operation, current }).run())
    .then((audit) => (audit.meta.changes === 1 ? "recorded" : "credential_refused"))
    .catch((error: unknown) => (refusedByAuditBudget(error) ? "rate_limited" : "unavailable"));

const utcDayMilliseconds = 86_400_000;
/** Matches the 256-entry stable-User triggers in 0015_statement_submission.sql; the triggers stay the authority. */
export const dailyAuditBudget = 256;
/** The canonical AuditLogEntry rows one User's UTC day counts: transaction, PAT, category, Memory, statement submission. */
const auditDayRows = `SELECT occurred_at_ms FROM transaction_audit WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM pat_audit WHERE user_id = ?
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM category_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM memory_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM statement_submission_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?`;
/** How many canonical audit rows one User has committed in the UTC day containing `current`. */
export const dailyAuditCount = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<number> => {
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  return db
    .prepare(`SELECT count(*) AS total FROM (${auditDayRows})`)
    .bind(
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds
    )
    .first<{ total: number }>()
    .then((row) => row?.total ?? 0);
};
export const transactionAuditExhausted = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<boolean> =>
  dailyAuditCount({ db, userId, current }).then((count) => count >= dailyAuditBudget);
export const transactionUnavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: 503, headers: transactionNoStore });

export const transactionFailure = ({
  code,
  status,
  message,
}: Readonly<{
  code:
    | "unauthenticated"
    | "validation_failed"
    | "not_found"
    | "rate_limited"
    | "user_action_required";
  status: number;
  message: string;
}>): Response =>
  Response.json(
    { error: { code, message, ...(code === "validation_failed" ? { fields: [] } : {}) }, next: [] },
    { status, headers: transactionNoStore }
  );

const HTTP_UNAUTHENTICATED = 401;
const invalid = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: 400,
    message: invalidTransactionMessage,
  });
const missing = (): Response =>
  transactionFailure({
    code: "not_found",
    status: 404,
    message: missingTransactionMessage,
  });
const limited = (): Response =>
  transactionFailure({
    code: "rate_limited",
    status: 429,
    message: "Manual Transaction budget exhausted.",
  });

/**
 * The one decision table for a closed refusal outcome: the canonical failure code every batch
 * child reports and the body the individual caller receives. A new outcome cannot be added
 * without answering both here.
 */
const refusalOutcomes: Readonly<
  Record<TransactionRefusal["outcome"], Readonly<{ code: ErrorCode; response: () => Response }>>
> = {
  not_found: { code: "not_found", response: missing },
  validation_failed: { code: "validation_failed", response: invalid },
  resource_limit: { code: "rate_limited", response: limited },
};

/** Map one already-recorded Transaction refusal to its canonical individual response. */
export const refusedTransactionResponse = (refusal: TransactionRefusal): Response =>
  refusalOutcomes[refusal.outcome].response();

/** The canonical daily-write-budget refusal every Transaction entry point shares. */
export const rateLimitedTransactionResponse = (): Response => limited();

/** The canonical failure code one already-recorded Transaction refusal is reported as. */
export const refusalFailureCode = (outcome: TransactionRefusal["outcome"]): ErrorCode =>
  refusalOutcomes[outcome].code;

/** Refuse one authenticated canonical Transaction mutation after its refusal Audit committed. */
export const rejectTransactionMutation = ({
  db,
  subject,
  operation,
  refusal,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: TransactionMutationOperation;
  refusal: TransactionRefusal;
  current: number;
}>): Promise<Response> =>
  recordTransactionRefusal({
    db,
    subject,
    outcome: refusal.outcome,
    operation,
    current,
  }).then((record) => {
    switch (record) {
      case "credential_refused":
        return refusedTransactionWork({ db, subject });
      case "rate_limited":
        return limited();
      case "unavailable":
        return transactionUnavailable();
      case "recorded":
        return refusedTransactionResponse(refusal);
    }
  });

/** Refuse one authenticated canonical Transaction call whose input failed validation. */
export const rejectInvalidTransactionInput = ({
  db,
  subject,
  operation,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: TransactionMutationOperation;
}>): Promise<Response> =>
  rejectTransactionMutation({
    db,
    subject,
    operation,
    current: transactionNow(),
    refusal: { outcome: "validation_failed", message: invalidTransactionMessage },
  });

/**
 * Refuse an atomic batch whose body does not satisfy the published schemas. This is the declared
 * `ValidationFailed` failure every canonical operation exposes through the ValidationGate, not a
 * child failure: no child was named by a decodable call, so no refusal Audit is recorded and no
 * child index is fabricated.
 */
export const rejectInvalidBatchInput = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: 400,
    message: "Invalid atomic batch input.",
  });

/** Classify a PAT protected-work refusal after re-reading the current User Consent decision. */
export const refusedPATWork = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Promise<Response> =>
  Effect.tryPromise({
    try: () =>
      db.prepare("SELECT 1 FROM consent_user_revocations WHERE user_id = ?").bind(userId).first(),
    catch: () => undefined,
  }).pipe(
    Effect.map((withdrawn) =>
      withdrawn === null
        ? transactionFailure({
            code: "unauthenticated",
            status: HTTP_UNAUTHENTICATED,
            message: "Present a valid credential and retry.",
          })
        : transactionFailure({
            code: "user_action_required",
            status: 403,
            message: "Return to Fidy to review your withdrawn Consent.",
          })
    ),
    Effect.runPromise
  );

/** The canonical unauthenticated response every Transaction entry point shares. */
export const unauthenticatedTransaction = (): Response =>
  transactionFailure({
    code: "unauthenticated",
    status: HTTP_UNAUTHENTICATED,
    message: "Present a valid credential and retry.",
  });

/** Classify a Transaction credential refusal against the live PAT and Consent decisions. */
export const refusedTransactionWork = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: TransactionCaller }>): Promise<Response> =>
  isPATCaller(subject)
    ? refusedPATWork({ db, userId: subject.userId })
    : Promise.resolve(unauthenticatedTransaction());

/** Classify a credential refusal, closing over any dependency defect as canonical unavailable. */
export const refusedCredentialResponse = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: TransactionCaller }>): Effect.Effect<Response> =>
  Effect.tryPromise(() => refusedTransactionWork({ db, subject })).pipe(
    Effect.orElseSucceed(transactionUnavailable)
  );

/** One live-authority gate over a credential table: its table, predicate, and bindings. */
export type TransactionAuthority = PATAuthority | WebSessionAuthority;
/** Recheck bearer, lifetime, scope, and Consent for either Transaction caller inside a D1 unit. */
export const callerAuthority = ({
  subject,
  current,
}: Readonly<{ subject: TransactionCaller; current: number }>): TransactionAuthority =>
  isPATCaller(subject)
    ? livePATAuthority({ subject, current })
    : liveWebSessionAuthority({ subject, current });

const authorityExists = (db: D1Database, authority: TransactionAuthority): Promise<boolean> =>
  db
    .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
    .bind(...authority.bindings)
    .first()
    .then((row) => row !== null);

/** True while the caller's credential exists, regardless of scope; classification only. */
export const liveTransactionCredential = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Promise<boolean> =>
  authorityExists(
    db,
    isPATCaller(subject)
      ? livePATCredential({ subject, current })
      : liveWebSessionAuthority({ subject, current })
  );

/** True while the caller's authority for the exact scope it presented is still live. */
export const liveTransactionAuthority = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Promise<boolean> => authorityExists(db, callerAuthority({ subject, current }));
