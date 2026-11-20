import {
  CanonicalCapability,
  CanonicalOperationId,
} from "../../src/core/canonical-operations/contract";
import { maximumAtomicBatchCalls } from "../../src/shell/operations/contract";
import type { BudgetOutcome } from "../budgets/contract";
import type { OAuthMutationReview } from "../oauth-confirmation/contract";
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

export type OwnerOutcome = Readonly<{
  _tag: "Owner";
  operation: string;
  collisionKey: Option.Option<string>;
  guardFacts: Option.Option<BudgetOutcome | KeywordRuleOutcome>;
  read: (db: D1Database, userId: string) => Effect.Effect<Option.Option<CommittedMutationValue>>;
}>;

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

export type GuardRefusalWork = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  earlier: ReadonlyArray<CanonicalMutationOutcome>;
  kind: "completion" | "capacity";
}>;

export type PreparedCanonicalMutation = Readonly<{
  oauthReview: Option.Option<OAuthMutationReview>;

  requiredScope: Option.Option<CanonicalCapability>;
  statements: ReadonlyArray<D1PreparedStatement>;
  outcome: CanonicalMutationOutcome;
  commitGuards: Option.Option<
    (
      work: Readonly<{
        db: D1Database;
        userId: string;
        current: number;
        index: number;
      }>
    ) => ReadonlyArray<D1PreparedStatement>
  >;

  guardRefusal: (work: GuardRefusalWork) => Effect.Effect<CanonicalMutationRefusal>;
}>;

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

export type CanonicalMutationRefusal = Readonly<{
  code: ErrorCode;
  message: string;
  record: () => Effect.Effect<CanonicalRefusalDisposition>;
  respond: (disposition: CanonicalRefusalDisposition) => Effect.Effect<Response>;
}>;

export type CanonicalMutationPreparation =
  | Readonly<{ _tag: "Prepared"; mutation: PreparedCanonicalMutation }>
  | Readonly<{ _tag: "Refused"; refusal: CanonicalMutationRefusal }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Failed" }>;

export const BatchCalls = Schema.NonEmptyArray(Schema.Unknown).check(
  Schema.isMaxLength(maximumAtomicBatchCalls)
);
export type BatchCalls = typeof BatchCalls.Type;
const Batch = { calls: BatchCalls } as const;

const Call = {
  operation: CanonicalOperationId,
  input: Schema.Unknown,
} as const;

export const CanonicalWork = Schema.Union([
  Schema.TaggedStruct("Call", Call),
  Schema.TaggedStruct("Query", {
    operation: CanonicalOperationId,
    target: Schema.String.check(Schema.isPattern(/^\//u)),
  }),
  Schema.TaggedStruct("Batch", Batch),
]);
export type CanonicalWork = typeof CanonicalWork.Type;

export const BatchInput = Schema.Struct(Batch);
export type BatchInput = typeof BatchInput.Type;

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

export const CanonicalWorkAdmission = Schema.Union([
  Schema.TaggedStruct("WebSessionQueryWork", {
    ...WebSession,
    work: CanonicalWork.check(
      Schema.makeFilter(
        (work) =>
          work._tag === "Query" &&
          ["dashboard.getDashboardView", "recurringPlans.getRecurringWorkspace"].includes(
            work.operation
          )
      )
    ),
    leaseId: Schema.String.check(Schema.isUUID()),
  }),
  Schema.TaggedStruct("WebSessionWork", { ...WebSession, work: CanonicalWork }),
  Schema.TaggedStruct("PATWork", { ...PAT, work: CanonicalWork }),
]);
export type CanonicalWorkAdmission = typeof CanonicalWorkAdmission.Type;

type WebSessionAuthority = Omit<
  Extract<CanonicalWorkAdmission, { _tag: "WebSessionWork" }>,
  "_tag" | "work"
>;

type PATAuthority = Omit<Extract<CanonicalWorkAdmission, { _tag: "PATWork" }>, "_tag" | "work">;
export type { PATAuthority, WebSessionAuthority };
