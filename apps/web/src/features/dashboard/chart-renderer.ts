import { createContext } from "react";
import type { JSX } from "react";
import { Option } from "effect";
import type { DashboardView, DashboardWidgetView } from "./presentation";

export type DashboardSpendingProps = Readonly<{
  data: Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
  locale: DashboardView["context"]["locale"];
}>;

export type DashboardSpendingRenderer = (props: DashboardSpendingProps) => JSX.Element;
export const DashboardSpendingPresentation = createContext(
  Option.none<DashboardSpendingRenderer>()
);
