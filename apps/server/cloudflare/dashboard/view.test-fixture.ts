import { BigDecimal, type Cause, Effect, Schema } from "effect";
import { expect } from "vitest";
import { DashboardView } from "../../src/shell/dashboard/contract";

const okStatus = 200;
export const metricTotals = (
  response: Response
): Effect.Effect<ReadonlyArray<string>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    expect(response.status).toBe(okStatus);
    const view = (yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
    )(yield* Effect.tryPromise(() => response.json()))).data;
    const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
      node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
    const metric = leaves(view.layout).find(
      (node) => node.kind === "leaf" && node.widget.widget.type === "custom-metric"
    );
    if (metric?.kind !== "leaf" || !("moneyGroups" in metric.widget.result)) {
      throw new Error("Expected custom metric");
    }
    return metric.widget.result.moneyGroups.map((group) => BigDecimal.format(group.outflow.amount));
  });

export const listIds = Effect.fn(function* (response: Response, widgetId: string) {
  expect(response.status).toBe(okStatus);
  const view = (yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
  )(yield* Effect.tryPromise(() => response.json()))).data;
  const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
    node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
  const list = leaves(view.layout).find(
    (node) => node.kind === "leaf" && node.widget.widget.id === widgetId
  );
  if (list?.kind !== "leaf" || !("transactions" in list.widget.result)) {
    throw new Error("Expected list results");
  }
  return list.widget.result.transactions.map((transaction) => transaction.id);
});
