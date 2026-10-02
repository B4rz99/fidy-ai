import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
} from "../canonical-operations/contract";
import {
  type CanonicalRefusalDisposition,
  type TransactionAuthority,
  TransactionBoundaryFailure,
  type TransactionCaller,
  type TransactionMutationOperation,
  type TransactionRefusal,
  type TransactionSubject,
  invalidTransactionMessage,
  missingTransactionMessage,
  transactionNoStore,
} from "./contract";
import { readConsentStatus } from "../consent/operations";
import { Clock, Effect, Option } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  recordedPATCallProof,
  refusedByAuditBudget,
} from "../../src/shell/audit/operations";
import { type CanonicalCapability } from "../../src/core/canonical-operations/contract";
import { type ErrorCode } from "../../src/shell/public-http/contract";
import { atomicBatchOperation } from "../../src/shell/operations/contract";

import { liveWebSessionAuthority } from "../../src/shell/identity/operations";
import { type AuditedPATMutation, type PATAuthority } from "../../src/shell/tokens/contract";
import {
  livePATAuthority,
  livePATCredential,
  recordAuditedPATUseFromAuthority,
} from "../../src/shell/tokens/operations";
import type { AuthorizedPAT } from "../tokens/contract";
import { prepareOwnedStatement } from "../database/operations";
import { newId } from "../secret-material/operations";

/** Wrap one rejected dependency promise so the failure channel stays typed. */
export const boundaryFailure = (cause: unknown): TransactionBoundaryFailure =>
  new TransactionBoundaryFailure({ cause });

/** True when the caller is an authorized PAT rather than a WebSession. */
export const isPATCaller = (subject: TransactionCaller): subject is AuthorizedPAT =>
  "patId" in subject;
/** The exact PAT capability a caller operates under; a WebSession carries none. */
export const callerScope = (subject: TransactionCaller): Option.Option<CanonicalCapability> =>
  isPATCaller(subject) ? subject.requiredScope : Option.none();
/** Restore the exact authority one canonical child is executed and audited under: a PAT scope. */
export const childCaller = ({
  subject,
  requiredScope,
}: Readonly<{
  subject: TransactionCaller;
  requiredScope: Option.Option<CanonicalCapability>;
}>): TransactionCaller =>
  isPATCaller(subject) && Option.isSome(requiredScope) ? { ...subject, requiredScope } : subject;
export const transactionNow = (): number => Effect.runSync(Clock.currentTimeMillis);
export const transactionId = (): string => newId();

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
      statement: recordCanonicalPATWork({
        authority,
        input: { afterOwnerWrite, current, id: auditId, operation, outcome: "accepted" },
      }),
    }),
    prepareOwnedStatement({
      db: database,
      statement: recordAuditedPATUseFromAuthority({
        authority,
        current,
        evidence: recordedPATCallProof({ auditId, operation }),
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
          authority: livePATAuthority({ subject, current }),
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
  return prepareAuthorizedAuditCall({
    db,
    authority,
    id: transactionId(),
    operation,
    outcome,
    current,
    afterOwnerWrite: false,
  });
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
 * Return the batch's declared ValidationGate failure without a child index. The caller decides
 * whether this refusal owes envelope Audit evidence before returning this response.
 */
export const rejectInvalidBatchInput = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: 400,
    message: "Invalid atomic batch input.",
  });

/**
 * Record one authenticated, pre-admission batch refusal without child attribution. This row is
 * metadata-only and excluded from the daily canonical-work budget by the D1 audit triggers.
 * A PAT needs a live credential and Consent, but no child scope: no child was admitted.
 */
const batchEnvelopeStatement = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): D1PreparedStatement => {
  if (isPATCaller(subject)) {
    const authority = livePATCredential({ subject, current });
    return prepareAuthorizedAuditCall({
      db,
      authority,
      id: transactionId(),
      operation: atomicBatchOperation,
      outcome: "rejected",
      current,
      afterOwnerWrite: false,
    });
  }
  const authority = liveWebSessionAuthority({ subject, current });
  return prepareAuthorizedAuditCall({
    db,
    authority,
    id: transactionId(),
    operation: atomicBatchOperation,
    outcome: "validation_failed",
    current,
    afterOwnerWrite: false,
  });
};

/**
 * Record one metadata-only envelope refusal for a live credential. Return the declared validation
 * failure only after the row commits; otherwise answer credential refusal, the separate daily
 * envelope rate limit, or unavailable without claiming evidence was recorded.
 */
export const rejectBatchEnvelope = (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    current: number;
  }>
): Promise<Response> => {
  const { db, subject } = input;
  return Promise.resolve()
    .then(() => batchEnvelopeStatement(input).run())
    .then((result) =>
      result.meta.changes === 1
        ? rejectInvalidBatchInput()
        : refusedTransactionWork({ db, subject })
    )
    .catch((cause: unknown) =>
      String(cause).includes("batch_envelope_limit")
        ? transactionFailure({
            code: "rate_limited",
            status: 429,
            message: "Atomic batch refusal budget exhausted.",
          })
        : transactionUnavailable()
    );
};

/** Classify a PAT protected-work refusal after re-reading the current User Consent decision. */
export const refusedPATWork = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Promise<Response> =>
  readConsentStatus({ db, userId }).pipe(
    Effect.map((standing) =>
      standing !== "Revoked"
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

/** Narrow a live authority to its PAT credential for statement accountability. */
export const isPATAuthority = (authority: TransactionAuthority): authority is PATAuthority =>
  authority.table === "pats";
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

export type {
  CanonicalRefusalDisposition,
  TransactionSubject,
  TransactionCaller,
  TransactionMutationOperation,
  TransactionRefusal,
  TransactionAuthority,
} from "./contract";
export {
  TransactionBoundaryFailure,
  transactionNoStore,
  maximumTransactionInputBytes,
  missingTransactionMessage,
  invalidTransactionMessage,
  pairPolicyMessage,
  alreadyLinkedMessage,
  unlinkedPairMessage,
} from "./contract";

export { dailyAuditMessage } from "./contract";

/** An exhausted shared audit budget cannot write another refusal AuditLogEntry. */
export const auditLimitRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: "Daily audit budget exhausted.",
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(transactionUnavailable()),
});

/** Build one owner refusal as the preparation every executor maps to its canonical response. */
export const refusedPreparation = (
  refusal: CanonicalMutationRefusal
): CanonicalMutationPreparation => ({
  _tag: "Refused",
  refusal,
});

/** Build the closed preparation failure for a dependency defect the executor classifies. */
export const failedPreparation = (): CanonicalMutationPreparation => ({ _tag: "Failed" });

/** Build the decided refusal for a credential the owner proved dead or scopeless. */
export const credentialRefusedPreparation = (): CanonicalMutationPreparation => ({
  _tag: "CredentialRefused",
});

/** Build the decided answer for an owner read that cannot decide this mutation. */
export const unavailablePreparation = (): CanonicalMutationPreparation => ({
  _tag: "Unavailable",
});
