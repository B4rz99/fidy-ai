import { type ComponentType, createContext } from "react";
import { Option } from "effect";
import type { CanonicalSuccess } from "@/transport/client";
import type { Category, Occurrence } from "./model";

export type CaptureStatus = "idle" | "saving" | "saved" | "failed" | "uncertain";
export type CaptureEditorProps = Readonly<{
  categories: ReadonlyArray<Category>;
  currency: Occurrence["plan"]["currency"];
  direction: "inflow" | "outflow";
  timeZone: string;
  initial: Readonly<{
    amount: string;
    occurredOn: string;
    counterparty: string;
    categoryId: string;
  }>;
  disabled: boolean;
  status: CaptureStatus;
  onStatus: (status: CaptureStatus) => void;
  onCreated: (transaction: CanonicalSuccess<"transactions.createTransaction">["data"]) => void;
  onCheckHistory: () => void;
}>;

export const CaptureEditorContext = createContext<Option.Option<ComponentType<CaptureEditorProps>>>(
  Option.none()
);
