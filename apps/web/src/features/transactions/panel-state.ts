import type { Array, Option } from "effect";
import type { Transaction } from "./presentation";

/** Interaction state shared by the panel, its controls, and the responsive sheet. */
export type CorrectionStatus = "idle" | "saving" | "invalid" | "rejected" | "uncertain";
export type CaptureStatus = "idle" | "saving" | "saved" | "failed" | "uncertain";
export type DetailMode =
  | Readonly<{ _tag: "Viewing" }>
  | Readonly<{ _tag: "Editing"; status: CorrectionStatus }>;
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
      status: CorrectionStatus;
    }>
  | Readonly<{ _tag: "Capture"; status: CaptureStatus }>
  | Readonly<{ _tag: "Detail"; id: string; categoryId: Option.Option<string>; mode: DetailMode }>;
