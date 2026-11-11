import { createContext } from "react";
import { Option } from "effect";
import type { TransactionCaptureTask } from "./capture-task";

export type CaptureHistoryVersion = Readonly<{
  month: string;
  timeZone: string;
  generation: number;
}>;
export type ManualCapture = TransactionCaptureTask &
  Readonly<{
    check: Option.Option<CaptureHistoryVersion>;
    clear: () => void;
    checkHistory: (version: CaptureHistoryVersion) => void;
    resumeAfterInspection: (version: CaptureHistoryVersion) => void;
  }>;

export const ManualCaptureContext = createContext<Option.Option<ManualCapture>>(Option.none());
