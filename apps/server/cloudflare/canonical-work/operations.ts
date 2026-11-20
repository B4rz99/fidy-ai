import type { WebSessionAuthority } from "../../src/shell/web-session/contract";
import type { OAuthAuthority, OAuthCaller } from "../../src/shell/oauth-agents/contract";
import { liveOAuthAuthority } from "../../src/shell/oauth-agents/operations";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
} from "../canonical-operations/contract";
import {
  type CanonicalCaller,
  type CanonicalRefusalDisposition,
  type HostedCanonicalCaller,
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
import { Clock, Effect, Option } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  recordOAuthCall,
  recordedPATCallProof,
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
import { newId } from "../secret-material/operations";

export const boundaryFailure = (cause: unknown): TransactionBoundaryFailure =>
  new TransactionBoundaryFailure({ cause });

export const isPATCaller = (subject: CanonicalCaller): subject is AuthorizedPAT =>
  "patId" in subject;
export const isHostedCaller = (subject: CanonicalCaller): subject is HostedCanonicalCaller =>
  "_tag" in subject;

export const isOAuthCaller = (subject: CanonicalCaller): subject is OAuthCaller =>
  "oauthConnectionId" in subject;

export const callerScope = (subject: CanonicalCaller): Option.Option<CanonicalCapability> =>
  isPATCaller(subject) || isOAuthCaller(subject) ? subject.requiredScope : Option.none();

export const childCaller = <Caller extends QueryCaller>({
  subject,
  requiredScope,
}: Readonly<{ subject: Caller; requiredScope: Option.Option<CanonicalCapability> }>): Caller =>
  (isPATCaller(subject) || isOAuthCaller(subject)) && Option.isSome(requiredScope)
    ? { ...subject, requiredScope }
    : subject;
export const transactionNow = (): number => Effect.runSync(Clock.currentTimeMillis);
export const transactionId = (): string => newId();

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

export const acceptedHostedStatement = (
  input: Readonly<{
    db: D1Database;
    subject: HostedCanonicalCaller;
    current: number;
    operation: TransactionMutationOperation;
  }>
): D1PreparedStatement =>
  prepareAuthorizedAuditCall({
    db: input.db,
    authority: input.subject.authority,
    id: newId(),
    current: input.current,
    operation: input.operation,
    outcome: "success",
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
  subject: CanonicalCaller;
  outcome: TransactionRefusal["outcome"];
  operation: TransactionMutationOperation;
  current: number;
}>): D1PreparedStatement => {
  if (isHostedCaller(subject)) {
    return prepareAuthorizedAuditCall({
      db,
      authority: subject.authority,
      id: transactionId(),
      operation,
      outcome,
      current,
      afterOwnerWrite: false,
    });
  }
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
  const authority = callerAuthority({ subject, current });
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

export const recordTransactionRefusal = ({
  db,
  subject,
  outcome,
  operation,
  current,
}: Readonly<{
  db: D1Database;
  subject: CanonicalCaller;
  outcome: TransactionRefusal["outcome"];
  operation: TransactionMutationOperation;
  current: number;
}>): Promise<CanonicalRefusalDisposition> =>
  Promise.resolve()
    .then(() => refusalStatement({ db, subject, outcome, operation, current }).run())
    .then((audit) => (audit.meta.changes === 1 ? "recorded" : "credential_refused"))
    .catch(() => "unavailable");

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
    message: "Too many requests. Retry later.",
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

export const refusalFailureCode = (outcome: TransactionRefusal["outcome"]): ErrorCode =>
  refusalOutcomes[outcome].code;

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
      case "unavailable":
        return transactionUnavailable();
      case "recorded":
        return refusedTransactionResponse(refusal);
    }
  });

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

export const rejectInvalidBatchInput = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: 400,
    message: "Invalid atomic batch input.",
  });

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
  const authority = callerAuthority({ subject, current });
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
    .catch(() => transactionUnavailable());
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

export const refusedPATWork = (
  input: Readonly<{ db: D1Database; userId: string }>
): Promise<Response> => Effect.runPromise(refusedBearerWork(input));

export const unauthenticatedTransaction = (): Response =>
  transactionFailure({
    code: "unauthenticated",
    status: HTTP_UNAUTHENTICATED,
    message: "Present a valid credential and retry.",
  });

export const refusedTransactionWork = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: QueryCaller }>): Promise<Response> =>
  isPATCaller(subject) || isOAuthCaller(subject)
    ? refusedPATWork({ db, userId: subject.userId })
    : Promise.resolve(unauthenticatedTransaction());

export const refusedCredentialResponse = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: CanonicalCaller }>): Effect.Effect<Response> =>
  (isPATCaller(subject) || isOAuthCaller(subject)
    ? refusedBearerWork({ db, userId: subject.userId })
    : Effect.succeed(unauthenticatedTransaction())
  ).pipe(Effect.orElseSucceed(transactionUnavailable));

export const isPATAuthority = (authority: TransactionAuthority): authority is PATAuthority =>
  authority.table === "pats";

export function callerAuthority(
  input: Readonly<{ subject: OAuthCaller; current: number }>
): OAuthAuthority;
export function callerAuthority(
  input: Readonly<{ subject: HostedCanonicalCaller; current: number }>
): HostedCanonicalCaller["authority"];
export function callerAuthority(
  input: Readonly<{ subject: HostedCanonicalCaller | OAuthCaller; current: number }>
): HostedCanonicalCaller["authority"] | OAuthAuthority;
export function callerAuthority(
  input: Readonly<{ subject: HostedCanonicalCaller | TransactionSubject; current: number }>
): HostedCanonicalCaller["authority"] | WebSessionAuthority;
export function callerAuthority(
  input: Readonly<{ subject: TransactionSubject | AuthorizedPAT; current: number }>
): PATAuthority | WebSessionAuthority;
export function callerAuthority(
  input: Readonly<{ subject: CanonicalCaller; current: number }>
): QueryAuthority;
export function callerAuthority({
  subject,
  current,
}: Readonly<{ subject: CanonicalCaller; current: number }>): QueryAuthority {
  if (isHostedCaller(subject)) return subject.authority;
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

export const liveTransactionCredential = ({
  db,
  subject,
  current,
}: Readonly<{ db: D1Database; subject: CanonicalCaller; current: number }>): Promise<boolean> =>
  authorityExists(
    db,
    isPATCaller(subject)
      ? livePATCredential({ subject, current })
      : callerAuthority({
          subject: isOAuthCaller(subject) ? { ...subject, requiredScope: Option.none() } : subject,
          current,
        })
  );

export const liveTransactionAuthority = ({
  db,
  subject,
  current,
}: Readonly<{ db: D1Database; subject: CanonicalCaller; current: number }>): Promise<boolean> =>
  authorityExists(db, callerAuthority({ subject, current }));

export type {
  CanonicalCaller,
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
  maximumTransactionGroupInputBytes,
  missingTransactionMessage,
  invalidTransactionMessage,
  pairPolicyMessage,
  alreadyLinkedMessage,
  unlinkedPairMessage,
} from "./contract";

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
