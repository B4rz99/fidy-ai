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

const fullListPage = 50;

const categoryFilterPosition = 21,
  emptySearchPosition = 22,
  shortListPosition = 23;

export const assertListSelection = ({
  node,
  index,
  firstId,
}: Readonly<{ node: DashboardView["layout"]; index: number; firstId: string }>): void => {
  if (node.kind !== "leaf" || !("transactions" in node.widget.result)) {
    throw new Error("Expected Transaction list");
  }

  let pageSize = fullListPage;

  if (index === categoryFilterPosition || index === emptySearchPosition) pageSize = 0;
  else if (index === shortListPosition) pageSize = 2;
  expect(node.widget.result.transactions).toHaveLength(pageSize);
  expect(node.widget.result.transactions.slice(0, 1).map(({ id }) => id)).toEqual(
    pageSize === 0 ? [] : [firstId]
  );
};
