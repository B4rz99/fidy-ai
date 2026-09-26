import type { CanonicalCapability, ErrorCode } from "@fidy/server/canonical-runtime";
import type {
  CategoryId,
  CategoryKeyword,
  KeywordRule,
  KeywordRuleId,
} from "@fidy/server/categories";
import type { Memory, MemoryId } from "@fidy/server/memory-runtime";
import type { StatementSubmission } from "@fidy/server/statement-staging";
import type { EmailForwardingAddress } from "../../src/core/ingestion/model";
import type {
  PreparedStatementPublication,
  StatementStagingConfig,
} from "../ingestion/statement-staging";
import type { TransactionPair } from "@fidy/server/transaction-reconciliation";
import type {
  RestoredTransactionPair,
  TransactionPresentation,
} from "@fidy/server/transactions-runtime";
import type { Effect, Option } from "effect";
import type {
  CanonicalRefusalDisposition,
  TransactionMutationOperation,
} from "../transactions/transaction-boundary";
import type { StoredTransaction } from "../transactions/transaction-history";

/** How one Transaction mutation presents the records its response reads back. */
type TransactionReadback =
  | Readonly<{ _tag: "Transaction" }>
  /** The effective Transaction of one linked pair, presented as ordinary history returns it. */
  | Readonly<{ _tag: "EffectiveTransaction"; pair: TransactionPair }>
  /** The two independent originals one successful unlink restored, in canonical pair order. */
  | Readonly<{ _tag: "RestoredPair"; pair: TransactionPair }>;

/**
 * One keyword-rule change's retained facts. A create or update names the rule's full payload; a
 * delete names only the rule it removes, so the correlation is a union instead of optional fields.
 */
export type KeywordRuleOutcome =
  | Readonly<{
      _tag: "KeywordRule";
      operation: "categories.createKeywordRule" | "categories.updateKeywordRule";
      ruleId: KeywordRuleId;
      keyword: CategoryKeyword;
      categoryId: CategoryId;
    }>
  | Readonly<{
      _tag: "KeywordRule";
      operation: "categories.deleteKeywordRule";
      ruleId: KeywordRuleId;
    }>;

/**
 * One Memory change's retained facts. A remember or revise carries the record it wrote for
 * commit-time capacity attribution; a forget carries only the identity it removes.
 */
export type MemoryOutcome =
  | Readonly<{
      _tag: "Memory";
      operation: "memory.remember" | "memory.revise";
      memoryId: MemoryId;
      /** The exact record a remember or revise wrote, for commit-time capacity attribution. */
      candidate: Memory;
    }>
  | Readonly<{
      _tag: "Memory";
      operation: "memory.forget";
      memoryId: MemoryId;
    }>;

/**
 * One Transaction change's committed readback descriptor and the revision its guard observed, if it
 * observed one. It is the Transaction member of the shared outcome union.
 */
export type TransactionOutcome = Readonly<{
  _tag: "Transaction";
  operation: TransactionMutationOperation;
  transactionId: string;
  readback: TransactionReadback;
  /** The revision a correction observed and must still find, when it observed one. */
  expectedRevision: Option.Option<number>;
}>;

/**
 * One owner's committed readback descriptor: what the owner must read after the unit commits and
 * how that read presents. A new owner adds one variant, so the unit's exhaustive switches fail to
 * build until its readback, refusal, and abort attribution are answered.
 */
export type CanonicalMutationOutcome =
  | TransactionOutcome
  | KeywordRuleOutcome
  | MemoryOutcome
  | Readonly<{ _tag: "ForwardingAddress"; current: number }>
  | Readonly<{
      _tag: "StatementSubmission";
      publication: PreparedStatementPublication;
      config: StatementStagingConfig;
    }>;

/**
 * One owner-prepared canonical mutation, ready to join a caller-owned D1 unit.
 *
 * `statements` are the guard-chained writes that must all commit, ending in the mutation's success
 * AuditLogEntry so a silently skipped guard is caught by the unit. `completion` is the owner's
 * rollback assertion, appended immediately after `statements` so a skipped guard aborts the whole
 * unit instead of being noticed after commit. `outcome` selects how the unit reads the committed
 * records back and how an aborted unit attributes responsibility.
 */
export type PreparedCanonicalMutation = Readonly<{
  /**
   * The exact PAT capability the owner prepared this child under, so an abort or refusal the child
   * owns is recorded and audited against that same child authority. None means the owner prepared
   * the child for a WebSession, which carries no capability.
   */
  requiredScope: Option.Option<CanonicalCapability>;
  statements: ReadonlyArray<D1PreparedStatement>;
  completion: D1PreparedStatement;
  outcome: CanonicalMutationOutcome;
}>;

/** One canonical success value an owner read back after the unit committed. */
export type CommittedMutationValue =
  | Readonly<{ _tag: "Transaction"; transaction: StoredTransaction }>
  | Readonly<{ _tag: "EffectiveTransaction"; transaction: TransactionPresentation }>
  | Readonly<{ _tag: "RestoredPair"; pair: RestoredTransactionPair }>
  | Readonly<{ _tag: "KeywordRule"; rule: KeywordRule }>
  | Readonly<{ _tag: "RemovedKeywordRule"; id: KeywordRuleId }>
  | Readonly<{ _tag: "Memory"; memory: Memory }>
  | Readonly<{ _tag: "RemovedMemory"; id: MemoryId }>
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
