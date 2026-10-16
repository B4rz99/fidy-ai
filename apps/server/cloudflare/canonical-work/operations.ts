import type { WebSessionAuthority } from "../../src/shell/web-session/contract";
import type { OAuthAuthority, OAuthCaller } from "../../src/shell/oauth-agents/contract";
import { liveOAuthAuthority } from "../../src/shell/oauth-agents/operations";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
} from "../canonical-operations/contract";
import {
  type CanonicalRefusalDisposition,
  type QueryAuthority,
  type QueryCaller,
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
import { Clock, Effect, Option, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  recordOAuthCall,
  recordedPATCallProof,
  refusedByAuditBudget,
  utcDayMilliseconds,
} from "../../src/shell/audit/operations";
import { type CanonicalCapability } from "../../src/core/canonical-operations/contract";
import { type ErrorCode, ResourceLimited } from "../../src/shell/public-http/contract";
import { atomicBatchOperation } from "../../src/shell/operations/contract";
import { liveWebSessionAuthority } from "../../src/shell/identity/operations";
import { type AuditedPATMutation, type PATAuthority } from "../../src/shell/tokens/contract";
import {
  livePATAuthority,
  livePATCredential,
  recordAuditedPATUseFromAuthority,
} from "../../src/shell/tokens/operations";
import type { AuthorizedPAT } from "../tokens/contract";
import { newId } from "../secret-material/operations";

export const boundaryFailure = (cause: unknown): TransactionBoundaryFailure =>
  new TransactionBoundaryFailure({ cause });

export const isPATCaller = (subject: QueryCaller): subject is AuthorizedPAT => "patId" in subject;
/** Distinguish OAuth authority without granting browser or PAT lifecycle privileges. */
export const isOAuthCaller = (subject: QueryCaller): subject is OAuthCaller =>
  "oauthConnectionId" in subject;
/** The exact User-owned agent capability; a WebSession carries none. */
export const callerScope = (subject: QueryCaller): Option.Option<CanonicalCapability> =>
  isPATCaller(subject) || isOAuthCaller(subject) ? subject.requiredScope : Option.none();
/** Execute and audit one child under its exact PAT or OAuth capability; preserve browser authority unchanged. */
export const childCaller = <Caller extends QueryCaller>({
  subject,
  requiredScope,
}: Readonly<{ subject: Caller; requiredScope: Option.Option<CanonicalCapability> }>): Caller =>
  (isPATCaller(subject) || isOAuthCaller(subject)) && Option.isSome(requiredScope)
    ? { ...subject, requiredScope }
    : subject;
export const transactionNow = (): number => Effect.runSync(Clock.currentTimeMillis);
export const transactionId = (): string => newId();

/** Chain the accepted PAT Audit immediately after its owner write and PAT use immediately after that Audit. Both share one audit identity. */
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
    recordCanonicalPATWork({
      authority,
      input: { afterOwnerWrite, current, id: auditId, operation, outcome: "accepted" },
    }),

    recordAuditedPATUseFromAuthority({
      authority,
      current,
      evidence: recordedPATCallProof({ auditId, operation }),
    }),
  ].map(({ sql, params }) => database.prepare(sql).bind(...params));
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

/** Append OAuth mutation evidence after a completed owner write in the same protected unit. */
export const acceptedOAuthStatement = (
  input: Readonly<{
    db: D1Database;
    subject: OAuthCaller;
    current: number;
    operation: TransactionMutationOperation;
  }>
): D1PreparedStatement =>
  prepareAuthorizedAuditCall({
    db: input.db,
    authority: liveOAuthAuthority(input),
    id: newId(),
    current: input.current,
    operation: input.operation,
    outcome: "accepted",
    afterOwnerWrite: true,
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
}>): D1PreparedStatement => {
  if (isOAuthCaller(subject)) {
    const auditStatement = recordOAuthCall({
      authority: liveOAuthAuthority({ subject, current }),
      id: newId(),
      operation,
      outcome: "rejected",
      current,
    });
    return db.prepare(auditStatement.sql).bind(...auditStatement.params);
  }
  if (isPATCaller(subject)) {
    const auditStatement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject, current }),
      input: {
        id: transactionId(),
        current,
        operation,
        outcome: "rejected",
        afterOwnerWrite: false,
      },
    });
    return db.prepare(auditStatement.sql).bind(...auditStatement.params);
  }

  return sessionRefusalStatement({ db, subject, outcome, operation, current });
};

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

export const canonicalAuditRateLimitedResponse = (current: number): Response => {
  const millisecondsPerSecond = 1000;
  const retryAfterSeconds = Math.ceil(
    (utcDayMilliseconds - (current % utcDayMilliseconds)) / millisecondsPerSecond
  );
  return Response.json(
    Schema.encodeSync(Schema.toCodecJson(ResourceLimited))(
      ResourceLimited.make({
        error: {
          code: "rate_limited",
          message:
            "Alcanzaste el límite diario de solicitudes. Inténtalo después del reinicio diario.",
          retryAfterSeconds,
        },
        next: [],
      })
    ),
    { status: 429, headers: { ...transactionNoStore, "retry-after": String(retryAfterSeconds) } }
  );
};

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

const refusalOutcomes: Readonly<
  Record<TransactionRefusal["outcome"], Readonly<{ code: ErrorCode; response: () => Response }>>
> = {
  not_found: { code: "not_found", response: missing },
  validation_failed: { code: "validation_failed", response: invalid },
  resource_limit: { code: "rate_limited", response: limited },
};

export const refusedTransactionResponse = (refusal: TransactionRefusal): Response =>
  refusalOutcomes[refusal.outcome].response();

export const rateLimitedTransactionResponse = (): Response => {
  const response = limited();
  response.headers.set("retry-after", "1");
  return response;
};

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
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: TransactionMutationOperation;
  current: number;
}>): Promise<Response> =>
  rejectTransactionMutation({
    db,
    subject,
    operation,
    current,
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
  if (isOAuthCaller(subject)) {
    const auditStatement = recordOAuthCall({
      authority: liveOAuthAuthority({ subject, current }),
      id: newId(),
      operation: atomicBatchOperation,
      outcome: "rejected",
      current,
    });
    return db.prepare(auditStatement.sql).bind(...auditStatement.params);
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

const refusedBearerWork = Effect.fn(function* ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>) {
  return yield* readConsentStatus({ db, userId }).pipe(
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
    )
  );
});

/** Native Promise admission adapter; Effect owners compose refusedCredentialResponse instead. */
export const refusedPATWork = (
  input: Readonly<{ db: D1Database; userId: string }>
): Promise<Response> => Effect.runPromise(refusedBearerWork(input));

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
}: Readonly<{ db: D1Database; subject: QueryCaller }>): Promise<Response> =>
  isPATCaller(subject) || isOAuthCaller(subject)
    ? refusedPATWork({ db, userId: subject.userId })
    : Promise.resolve(unauthenticatedTransaction());

/** Classify a credential refusal, closing over any dependency defect as canonical unavailable. */
export const refusedCredentialResponse = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: QueryCaller }>): Effect.Effect<Response> =>
  (isPATCaller(subject) || isOAuthCaller(subject)
    ? refusedBearerWork({ db, userId: subject.userId })
    : Effect.succeed(unauthenticatedTransaction())
  ).pipe(Effect.orElseSucceed(transactionUnavailable));

export const isPATAuthority = (authority: TransactionAuthority): authority is PATAuthority =>
  authority.table === "pats";
/** Recheck bearer, lifetime, scope, and Consent for either Transaction caller inside a D1 unit. */
export function callerAuthority(
  input: Readonly<{ subject: OAuthCaller; current: number }>
): OAuthAuthority;
export function callerAuthority(
  input: Readonly<{ subject: Exclude<TransactionCaller, OAuthCaller>; current: number }>
): PATAuthority | WebSessionAuthority;
export function callerAuthority(
  input: Readonly<{ subject: QueryCaller; current: number }>
): PATAuthority | WebSessionAuthority | OAuthAuthority;
export function callerAuthority({
  subject,
  current,
}: Readonly<{ subject: QueryCaller; current: number }>): QueryAuthority {
  if (isOAuthCaller(subject)) return liveOAuthAuthority({ subject, current });
  return isPATCaller(subject)
    ? livePATAuthority({ subject, current })
    : liveWebSessionAuthority({ subject, current });
}

const authorityExists = (db: D1Database, authority: QueryAuthority): Promise<boolean> =>
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
}: Readonly<{ db: D1Database; subject: QueryCaller; current: number }>): Promise<boolean> =>
  authorityExists(
    db,
    isPATCaller(subject)
      ? livePATCredential({ subject, current })
      : callerAuthority({
          subject: isOAuthCaller(subject) ? { ...subject, requiredScope: Option.none() } : subject,
          current,
        })
  );

/** True while the caller's authority for the exact scope it presented is still live. */
export const liveTransactionAuthority = ({
  db,
  subject,
  current,
}: Readonly<{ db: D1Database; subject: QueryCaller; current: number }>): Promise<boolean> =>
  authorityExists(db, callerAuthority({ subject, current }));

export type {
  CanonicalRefusalDisposition,
  TransactionSubject,
  TransactionCaller,
  QueryCaller,
  QueryAuthority,
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

export const refusedPreparation = (
  refusal: CanonicalMutationRefusal
): CanonicalMutationPreparation => ({
  _tag: "Refused",
  refusal,
});

export const failedPreparation = (): CanonicalMutationPreparation => ({ _tag: "Failed" });

export const credentialRefusedPreparation = (): CanonicalMutationPreparation => ({
  _tag: "CredentialRefused",
});

export const unavailablePreparation = (): CanonicalMutationPreparation => ({
  _tag: "Unavailable",
});
