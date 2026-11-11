import type { Array, Option } from "effect";
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
export type ReconciliationMode = Readonly<{
  _tag: "Reconciling";
  pair: OriginalTransactions;
  sources: CaptureSources;
  deleting: boolean;
}> &
  (
    | Readonly<{
        status:
          | "review"
          | "saving"
          | "rejected"
          | "uncertain"
          | "recovering"
          | "success"
          | "missing";
      }>
    | Readonly<{ status: "separate"; original: Transaction }>
  );
export const reconciliationFinished = (mode: ReconciliationMode): boolean =>
  ["success", "separate", "missing"].includes(mode.status);
export const reconciliationLocked = (mode: ReconciliationMode): boolean =>
  mode.status !== "review" && !reconciliationFinished(mode);
export type DetailMode =
  | Readonly<{ _tag: "Viewing" }>
  | Readonly<{ _tag: "Editing" }>
  | ReconciliationMode
  | Readonly<{ _tag: "Deleting"; status: DeletionStatus; original: Option.Option<Transaction> }>;
export type TransactionPanel =
  | Readonly<{ _tag: "Summary" }>
  | Readonly<{
      _tag: "Bulk";
      stage: "selecting";
      ids: ReadonlyArray<string>;
    }>
  | Readonly<{
      _tag: "Bulk";
      stage: "editing";
      transactions: Array.NonEmptyReadonlyArray<Transaction>;
    }>
  | Readonly<{ _tag: "Capture"; status: "idle" | "saving" | "uncertain" }>
  | Readonly<{ _tag: "Detail"; id: string; mode: DetailMode }>;
