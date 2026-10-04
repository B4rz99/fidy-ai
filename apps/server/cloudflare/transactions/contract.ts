import type { IanaTimeZone } from "../../src/core/_shared/context";
import {
  type NotificationInterpretationEvidence,
  type RecurringTransactionFact,
  type Transaction,
  type TransactionExtraction,
  type TransactionPair,
} from "../../src/core/transactions/contract";
import type { TransactionMutationOperation } from "../canonical-work/contract";
import { Data, type DateTime, type Option } from "effect";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { type Category, type CategoryId } from "../../src/core/categories/contract";

import type { Money } from "../../src/core/_shared/money";
import type {
  NotificationEmailSourceAttestation,
  StatementLineSourceAttestation,
} from "../../src/core/source-attestation/contract";

/** Unreadable or malformed aggregate facts never become empty history or partial report totals. */
export class TransactionAggregatesUnavailable extends Data.TaggedError(
  "TransactionAggregatesUnavailable"
) {}

/** Unreadable or invalid recurring facts never supply a partial detection selection. */
export class RecurringFactsUnavailable extends Data.TaggedError("RecurringFactsUnavailable") {}

/** One complete revision snapshot of effective financial history; later commits must recheck this revision. */
export type RecurringFactSnapshot = Readonly<{
  revision: number;
  firstCapturedAt: DateTime.Utc;
  timeZone: IanaTimeZone;
}>;
/** Bounded recurring projection with an explicit continuation; changed history never supplies mixed facts. */
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
  /** Static source-owner SQL projecting user_id for eligible work at commit, with values bound in params. */
  sourceGuard: OwnedStatement;
}>;

/** Canonical capture facts and the historical statement evidence retained by the installed source path. */
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

/** Canonical capture facts and versioned notification evidence, already interpreted by the source owner. */
export type NotificationEmailCaptureInput = CaptureFacts &
  Readonly<{
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

/** A position in ascending effective Transaction order; it never conveys User authority. */
export type BudgetContributionCursor = Readonly<{
  occurredAt: string;
  transactionId: string;
}>;

/** Only the normalized Transaction facts needed to decide a Budget contribution. */
export type BudgetContribution = Pick<
  Transaction,
  "money" | "categoryId" | "direction" | "occurredAt"
>;

/** One bounded page, including the durable position to resume and whether the interval is exhausted. */
export type BudgetContributionPage = Readonly<{
  movements: ReadonlyArray<BudgetContribution>;
  cursor: BudgetContributionCursor;
  complete: boolean;
}>;

/** Explicit subject and half-open interval for one Category's outflows in one Currency. */
export type BudgetContributionQuery = Readonly<{
  db: D1Database;
  userId: string;
  categoryId: Transaction["categoryId"];
  currency: Money["currency"];
  period: Readonly<{ from: DateTime.Utc; to: DateTime.Utc }>;
  cursor: BudgetContributionCursor;
}>;

/** A normalized effective Transaction with its public Category metadata. */
export type DashboardTransactionFact = Readonly<{ transaction: Transaction; category: Category }>;

/** Bounded recent effective Transactions, optionally selected by Category and literal text. */
export type DashboardTransactionList = Readonly<{
  categories: ReadonlyArray<CategoryId>;
  search: Option.Option<string>;
  limit: number;
}>;

/**
 * A caller-owned read observed with the Transaction projection. The decoder receives only that
 * read's rows and must fail closed on absent or malformed facts; it cannot confer authority.
 */
export type DashboardSnapshotRead<A> = Readonly<{
  statement: D1PreparedStatement;
  decode: (rows: ReadonlyArray<unknown>) => Option.Option<A>;
}>;

/** One complete ready Transaction projection read and its atomically observed caller facts. */
export type DashboardTransactionSnapshot<A> = Readonly<{
  snapshot: A;
  lists: ReadonlyArray<ReadonlyArray<DashboardTransactionFact>>;
}>;

/** Explicit User and bounded list selections, together with public Category metadata. */
export type DashboardTransactionRead<A> = Readonly<{
  db: D1Database;
  userId: string;
  lists: ReadonlyArray<DashboardTransactionList>;
  categories: ReadonlyArray<Category>;
  snapshot: DashboardSnapshotRead<A>;
}>;

/** How one Transaction mutation presents the records its response reads back. */
type TransactionReadback =
  | Readonly<{ _tag: "Transaction" }>
  /** The effective Transaction of one linked pair, presented as ordinary history returns it. */
  | Readonly<{ _tag: "EffectiveTransaction"; pair: TransactionPair }>
  /** The two independent originals one successful unlink restored, in canonical pair order. */
  | Readonly<{ _tag: "RestoredPair"; pair: TransactionPair }>;

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
