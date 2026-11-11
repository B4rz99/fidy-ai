import { type ComponentType, type JSX, createContext } from "react";
import { Option } from "effect";
import type { CanonicalSuccess } from "@/transport/client";
import type { Category, Occurrence } from "./model";

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
  intentId: string;
  onInvalidate: () => void;
  renderForm: (
    form: JSX.Element,
    placement: Readonly<{ saving: boolean; uncertain: boolean }>
  ) => JSX.Element;
  onCreated: (transaction: CanonicalSuccess<"transactions.createTransaction">["data"]) => void;
  onCheckHistory: () => void;
}>;

export const CaptureEditorContext = createContext<Option.Option<ComponentType<CaptureEditorProps>>>(
  Option.none()
);
