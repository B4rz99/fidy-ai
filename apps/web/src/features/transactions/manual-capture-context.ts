import { createContext } from "react";
import { Option } from "effect";
import type { CaptureStatus } from "./capture";
import type { CaptureDraft } from "./capture-draft";

export type CaptureHistoryVersion = Readonly<{ month: string; generation: number }>;
export type ManualCaptureState = Readonly<{
  draft: CaptureDraft;
  status: CaptureStatus;
  attempt: Option.Option<CaptureDraft>;
  check: Option.Option<CaptureHistoryVersion>;
}>;
export type ManualCapture = ManualCaptureState &
  Readonly<{
    change: (draft: CaptureDraft) => void;
    onStatus: (status: CaptureStatus) => void;
    clear: () => void;
    checkHistory: (version: CaptureHistoryVersion) => void;
    resume: () => void;
  }>;

export const ManualCaptureContext = createContext<Option.Option<ManualCapture>>(Option.none());
