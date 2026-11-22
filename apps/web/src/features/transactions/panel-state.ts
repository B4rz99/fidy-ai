import { type Array, Data, type Option } from "effect";
import type { CaptureSources, OriginalTransactions, Transaction } from "./presentation";

export type CorrectionStatus =
  | "idle"
  | "saving"
  | "invalid"
  | "rejected"
  | "uncertain"
  | "refreshing"
  | "recovered";

export type DeletionStatus = "idle" | "saving" | "rejected" | "uncertain";

export const reconciliationFinished = (mode: ReconciliationMode): boolean =>
  ["success", "separate", "missing"].includes(mode.status);

export const reconciliationLocked = (mode: ReconciliationMode): boolean =>
  mode.status !== "review" && !reconciliationFinished(mode);

export type ReconciliationStatus =
  | "review"
  | "saving"
  | "rejected"
  | "uncertain"
  | "recovering"
  | "success"
  | "missing"
  | "separate";

export type DetailMode = Data.TaggedEnum<{
  Viewing: {};
  Editing: {};
  Reconciling: {
    readonly pair: OriginalTransactions;
    readonly sources: CaptureSources;
    readonly deleting: boolean;
    readonly status: ReconciliationStatus;
    readonly separated: Option.Option<Transaction>;
  };
  Deleting: { readonly status: DeletionStatus; readonly original: Option.Option<Transaction> };
}>;

export const DetailMode = Data.taggedEnum<DetailMode>();

export type ReconciliationMode = Data.TaggedEnum.Value<DetailMode, "Reconciling">;

export type BulkSelection = Data.TaggedEnum<{
  Selecting: { readonly ids: ReadonlyArray<string> };
  Editing: { readonly transactions: Array.NonEmptyReadonlyArray<Transaction> };
}>;

export const BulkSelection = Data.taggedEnum<BulkSelection>();

export type TransactionPanel = Data.TaggedEnum<{
  Summary: {};
  Bulk: { readonly selection: BulkSelection };
  Capture: { readonly status: "idle" | "saving" | "uncertain" };
  Detail: { readonly id: string; readonly mode: DetailMode };
}>;

export const TransactionPanel = Data.taggedEnum<TransactionPanel>();
