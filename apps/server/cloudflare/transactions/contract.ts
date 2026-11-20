import type { CanonicalReadFinalization } from "../canonical-admission/contract";
import type { CapturedInterpretationContext } from "../../src/core/interpretation-evidence/contract";
import type { IanaTimeZone } from "../../src/core/_shared/context";
import {
  type EffectiveTransactionAggregate,
  type NotificationInterpretationEvidence,
  type RecurringTransactionFact,
  type Transaction,
  type TransactionExtraction,
  type TransactionPair,
} from "../../src/core/transactions/contract";
import type { TransactionMutationOperation } from "../canonical-work/contract";
import { Data, type DateTime, type Effect, type Option } from "effect";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { type Category, type CategoryId } from "../../src/core/categories/contract";

import type { WebSessionSubject } from "../../src/shell/web-session/contract";
import type { PrivacyTransactionRequest } from "../../src/shell/processing-consent/contract";

import type {
  NotificationEmailSourceAttestation,
  StatementLineSourceAttestation,
} from "../../src/core/source-attestation/contract";

export type PrivacyTransactionsRead = Readonly<{
  db: D1Database;
  subject: WebSessionSubject;
  request: typeof PrivacyTransactionRequest.Type;
}>;

export class TransactionAggregatesUnavailable extends Data.TaggedError(
  "TransactionAggregatesUnavailable"
) {}

export class RecurringFactsUnavailable extends Data.TaggedError("RecurringFactsUnavailable") {}

export type PlanningTransactionRange = Readonly<{ from: string; through: string }>;
export type PlanningTransactionFacts = Readonly<{
  transactions: ReadonlyArray<Transaction>;
  complete: boolean;
}>;

export type PlanningTransactionSnapshot<A> = Readonly<{
  snapshot: A;
  ranges: ReadonlyArray<Option.Option<PlanningTransactionFacts>>;
  selected: ReadonlyArray<Transaction>;
}>;
export type PlanningTransactionRead<A> = Readonly<{
  db: D1Database;
  userId: string;
  ranges: ReadonlyArray<PlanningTransactionRange>;
  finalization: Option.Option<CanonicalReadFinalization>;
  ids: ReadonlyArray<string>;
  snapshot: Readonly<{
    statement: D1PreparedStatement;
    decode: (rows: ReadonlyArray<unknown>) => Option.Option<A>;
  }>;
}>;

export type RecurringFactSnapshot = Readonly<{
  revision: number;
  firstCapturedAt: DateTime.Utc;
  timeZone: IanaTimeZone;
}>;

export type RecurringFactPage = Readonly<{
  facts: ReadonlyArray<RecurringTransactionFact>;
  cursor: BudgetContributionCursor;
  complete: boolean;
}>;

type CaptureFacts = Readonly<{
  db: D1Database;
  userId: string;
  transactionId: string;
  extraction: TransactionExtraction;
  categoryId: CategoryId;
  sourceGuard: OwnedStatement;
}>;

export type StatementCaptureInput = CaptureFacts &
  Readonly<{
    attestation: Pick<
      typeof StatementLineSourceAttestation.Encoded,
      | "id"
      | "serviceMarket"
      | "locale"
      | "timeZone"
      | "interpretationRevision"
      | "createdAt"
      | "statementSubmissionId"
      | "statementRecordNumber"
      | "statementContentHash"
      | "sourceFormat"
    >;
  }>;

export type NotificationEmailCaptureInput = CaptureFacts &
  Readonly<{
    queuedAdmission: Option.Option<OwnedStatement>;
    attestation: Pick<
      typeof NotificationEmailSourceAttestation.Encoded,
      | "id"
      | "serviceMarket"
      | "locale"
      | "timeZone"
      | "interpretationRevision"
      | "createdAt"
      | "receivedEmailId"
      | "messageEvidence"
      | "messageContentSha256"
      | "sourceFormat"
      | "extractorRevision"
    >;
    interpretation: NotificationInterpretationEvidence;
  }>;

export type BudgetContributionCursor = Readonly<{
  occurredAt: string;
  transactionId: string;
}>;

export type DashboardTransactionFact = Readonly<{ transaction: Transaction; category: Category }>;

export type DashboardTransactionList = Readonly<{
  categories: ReadonlyArray<CategoryId>;
  search: Option.Option<string>;
  limit: number;
}>;

export type DashboardSnapshotRead<A> = Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  accepts: (proof: ReadonlyArray<unknown>) => boolean;
  decode: (results: ReadonlyArray<D1Result>) => Effect.Effect<Option.Option<A>>;
}>;

export type DashboardTransactionSnapshot<A> = Readonly<{
  snapshot: A;
  lists: ReadonlyArray<ReadonlyArray<DashboardTransactionFact>>;
  ranges: ReadonlyArray<ReadonlyArray<EffectiveTransactionAggregate>>;
}>;

export type DashboardTransactionRead<A> = Readonly<{
  db: D1Database;
  userId: string;
  lists: ReadonlyArray<DashboardTransactionList>;
  ranges: ReadonlyArray<Readonly<{ from: number; toExclusive: number }>>;
  categories: ReadonlyArray<Category>;
  snapshot: DashboardSnapshotRead<A>;
  finalization: Option.Option<CanonicalReadFinalization>;
}>;

type TransactionReadback =
  | Readonly<{ _tag: "Transaction" }>
  | Readonly<{ _tag: "DeletedTransaction" }>
  | Readonly<{ _tag: "EffectiveTransaction"; pair: TransactionPair }>
  | Readonly<{ _tag: "RestoredPair"; pair: TransactionPair }>;

export type TransactionOutcome = Readonly<{
  _tag: "Transaction";
  operation: TransactionMutationOperation;
  transactionId: string;
  readback: TransactionReadback;
  expectedRevision: Option.Option<number>;
}>;

export type ReviewedCaptureInput = CaptureFacts &
  Readonly<{
    attestationId: string;
    createdAt: string;
    context: CapturedInterpretationContext;
    reviewItemId: string;
    userProvidedFields: ReadonlyArray<
      "money" | "direction" | "counterparty" | "occurredAt" | "categoryId"
    >;
  }>;
