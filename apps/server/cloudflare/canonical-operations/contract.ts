import {
  CanonicalCapability,
  CanonicalOperationId,
} from "../../src/core/canonical-operations/contract";
import { maximumAtomicBatchCalls } from "../../src/shell/operations/contract";
import type { BudgetOutcome } from "../budgets/contract";
import type { TransactionOutcome } from "../transactions/contract";
import type { KeywordRuleOutcome } from "../categories/contract";
import type { ErrorCode } from "../../src/shell/public-http/contract";
import type { StatementSubmission } from "../../src/shell/ingestion/contract";
import type { EmailForwardingAddress } from "../../src/core/ingestion/contract";
import type { StatementPublicationOutcome } from "../ingestion/contract";
import type {
  RestoredTransactionPair,
  Transaction,
  TransactionPresentation,
} from "../../src/core/transactions/contract";
import { type Effect, type Option, Schema } from "effect";
import type { CanonicalRefusalDisposition, TransactionCaller } from "../canonical-work/contract";

export type MutationTriggerKind = "movement" | "capacity" | "audit";

type OwnerWork = Readonly<{ db: D1Database; subject: TransactionCaller; current: number }>;

/** Owner behavior at the shared commit, audit, and readback boundary. */
export type OwnerOutcome = Readonly<{
  _tag: "Owner";
  operation: string;
  collisionKey: Option.Option<string>;
  /** Owner-specific facts retained for earlier-child guard replay inside one batch. */
  guardFacts: Option.Option<BudgetOutcome | KeywordRuleOutcome>;
  read: (db: D1Database, userId: string) => Effect.Effect<Option.Option<CommittedMutationValue>>;
  triggerRefusal: (
    work: OwnerWork,
    kind: MutationTriggerKind
  ) => Option.Option<CanonicalMutationRefusal>;
}>;

/**
 * One owner's committed readback descriptor: what the owner must read after the unit commits and
 * how that read presents. A new owner adds one variant, so the unit's exhaustive switches fail to
 * build until its readback, refusal, and abort attribution are answered.
 */
export type CanonicalMutationOutcome =
  | OwnerOutcome
  | TransactionOutcome
  | Readonly<{
      _tag: "ForwardingAddress";
      operation: "ingestion.enableEmailForwarding";
      current: number;
    }>
  | Readonly<{
      _tag: "StatementSubmission";
      operation: "ingestion.submitForExtraction";
      publication: StatementPublicationOutcome;
    }>;

/** Facts an owner needs to classify its own indexed guard refusal after rollback. */
export type GuardRefusalWork = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  earlier: ReadonlyArray<CanonicalMutationOutcome>;
  /** The indexed CHECK that proved this child, not an error string guessed after rollback. */
  kind: "completion" | "capacity";
}>;

/**
 * One owner-prepared canonical mutation ready for a caller-owned D1 unit. `statements` end with
 * the success AuditLogEntry; the unit appends an indexed rollback assertion after them.
 * `outcome` drives committed readback, and `guardRefusal` decides a proved completion failure.
 */
export type PreparedCanonicalMutation = Readonly<{
  /**
   * The exact PAT capability the owner prepared this child under, so an abort or refusal the child
   * owns is recorded and audited against that same child authority. None means the owner prepared
   * the child for a WebSession, which carries no capability.
   */
  requiredScope: Option.Option<CanonicalCapability>;
  statements: ReadonlyArray<D1PreparedStatement>;
  outcome: CanonicalMutationOutcome;
  /** Owner-defined checks run after the shared Audit check but before this child's writes. */
  commitGuards: Option.Option<
    (
      work: Readonly<{
        db: D1Database;
        userId: string;
        current: number;
        index: number;
        operation: string;
      }>
    ) => ReadonlyArray<D1PreparedStatement>
  >;
  /** Browser Budget Audits use their own cap rather than the shared PAT/Category cap. */
  auditBudget: "shared" | "owner";
  /** Construct the owner's refusal; its metadata-only Audit is recorded only when `record` runs. */
  guardRefusal: (work: GuardRefusalWork) => Effect.Effect<CanonicalMutationRefusal>;
}>;

/** One canonical success value an owner read back after the unit committed. */
export type CommittedMutationValue =
  | Readonly<{
      _tag: "Owner";
      payload: unknown;
      encode: () => Effect.Effect<unknown, Schema.SchemaError>;
    }>
  | Readonly<{ _tag: "Transaction"; transaction: Transaction }>
  | Readonly<{ _tag: "EffectiveTransaction"; transaction: TransactionPresentation }>
  | Readonly<{ _tag: "RestoredPair"; pair: RestoredTransactionPair }>
  | Readonly<{ _tag: "StatementSubmission"; submission: StatementSubmission }>
  | Readonly<{ _tag: "ForwardingAddress"; address: EmailForwardingAddress }>;

/**
 * One canonical refusal an owner decided. `code` and `message` are what a batch child reports;
 * `record` commits the owner's refusal AuditLogEntry under the exact child authority, and
 * `respond` renders the owner's own canonical individual response for that disposition.
 */
export type CanonicalMutationRefusal = Readonly<{
  code: ErrorCode;
  message: string;
  record: () => Effect.Effect<CanonicalRefusalDisposition>;
  respond: (disposition: CanonicalRefusalDisposition) => Effect.Effect<Response>;
}>;

/**
 * One owner's answer for a canonical mutation before its caller-owned unit may commit. The three
 * payload-free arms differ by who answers: `CredentialRefused` and `Unavailable` are decided, so
 * the executor renders them directly, while `Failed` is a dependency defect the executor
 * re-classifies against the live credential before answering.
 */
export type CanonicalMutationPreparation =
  | Readonly<{ _tag: "Prepared"; mutation: PreparedCanonicalMutation }>
  | Readonly<{ _tag: "Refused"; refusal: CanonicalMutationRefusal }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Failed" }>;

/**
 * The bounded raw child list a Batch work payload carries. Each entry stays `Unknown` here because the
 * batch adapter decodes it against the published catalog call union, where a malformed child can
 * still be attributed and audited as the child it named.
 */
export const BatchCalls = Schema.NonEmptyArray(Schema.Unknown).check(
  Schema.isMaxLength(maximumAtomicBatchCalls)
);
export type BatchCalls = typeof BatchCalls.Type;
const Batch = { calls: BatchCalls } as const;
/**
 * One canonical call an individual work payload carries: the operation id the catalog publishes and the
 * raw canonical input its owner adapter decodes. The operation id alone selects the owner adapter,
 * so a new composable mutation joins this dispatcher without editing it.
 */
const Call = {
  operation: CanonicalOperationId,
  input: Schema.Unknown,
} as const;

/**
 * Canonical work one User coordinator executes. A Call carries catalog-owned canonical input;
 * a Query carries only an admitted HTTP path/query target, never headers or credential plaintext;
 * a Batch carries the bounded raw child list. Query owners retain input classification and live
 * accounting; mutation owners retain their shared atomic commit.
 */
export const CanonicalWork = Schema.Union([
  Schema.TaggedStruct("Call", Call),
  Schema.TaggedStruct("Query", {
    operation: CanonicalOperationId,
    target: Schema.String.check(Schema.isPattern(/^\//u)),
  }),
  Schema.TaggedStruct("Batch", Batch),
]);
export type CanonicalWork = typeof CanonicalWork.Type;

/** The atomic batch request envelope: the bounded raw child list the adapter decodes per child. */
export const BatchInput = Schema.Struct(Batch);
export type BatchInput = typeof BatchInput.Type;

/** One owner preparation receives decoded catalog input and the caller's exact live authority. */
export type CanonicalPreparationWork = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  bucket: Option.Option<R2Bucket>;
  input: unknown;
}>;

const Credentials = {
  userId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
} as const;
const WebSession = { ...Credentials, sessionId: Schema.String.check(Schema.isUUID()) } as const;
const PAT = {
  ...Credentials,
  patId: Schema.String.check(Schema.isUUID()),
  requiredScope: Schema.NullOr(CanonicalCapability),
} as const;
/**
 * One work admission: the live subject authority plus the exact work it admits. It is not
 * itself a canonical mutation — the mutation travels inside `work` — so it is named for what it
 * does rather than for the thing it carries.
 */
export const CanonicalWorkAdmission = Schema.Union([
  Schema.TaggedStruct("WebSessionWork", { ...WebSession, work: CanonicalWork }),
  Schema.TaggedStruct("PATWork", { ...PAT, work: CanonicalWork }),
]);
export type CanonicalWorkAdmission = typeof CanonicalWorkAdmission.Type;

/**
 * The live WebSession facts an admission carries for one piece of work: the session id, its
 * User, and the proof digest the coordinator re-verifies against live authority before any D1 unit
 * commits. The work itself is excluded — it is what the authority admits, not part of it.
 */
type WebSessionAuthority = Omit<
  Extract<CanonicalWorkAdmission, { _tag: "WebSessionWork" }>,
  "_tag" | "work"
>;
/**
 * The live PAT facts an admission carries for one piece of work: the PAT id, its User, the
 * proof digest, and the required capability the coordinator re-verifies against live authority
 * before any D1 unit commits. The work itself is excluded — it is what the authority admits.
 */
type PATAuthority = Omit<Extract<CanonicalWorkAdmission, { _tag: "PATWork" }>, "_tag" | "work">;
export type { PATAuthority, WebSessionAuthority };
