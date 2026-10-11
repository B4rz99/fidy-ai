import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { type Mock, expect, it, vi } from "vitest";
import {
  Category,
  Transaction,
  TransactionId,
  User,
  maximumAtomicBatchCalls,
} from "@/transport/client";
import { Message, type Model, initialModel } from "./model";
import { makeWorkspaceUpdate } from "./workspace-update";

const category = Schema.decodeSync(Category)({
  id: "24000000-0000-4000-8000-000000000001",
  label: "Mercado",
});
const record = Schema.decodeSync(Transaction)({
  id: "24000000-0000-4000-8000-000000000002",
  categoryId: category.id,
  revision: 3,
  money: { amount: "25000", currency: "COP" },
  direction: "outflow",
  counterparty: "Tienda",
  occurredAt: "2026-10-09T12:30:00Z",
  createdAt: "2026-10-09T12:30:00Z",
});
const user = Schema.decodeSync(User)({
  id: "24000000-0000-4000-8000-000000000003",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  trialPeriod: { startedAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-08T00:00:00Z" },
  createdAt: "2026-01-01T00:00:00Z",
});
const ready: Model = {
  ...initialModel,
  query: {
    ...initialModel.query,
    user: Option.some(user),
    transactions: [record],
    categories: [category],
    status: "Ready",
    waiting: false,
  },
};
const complete = Command.define("WorkspaceTestCompleted", {
  args: {},
  messages: [Message.Completed],
  execute: () => Effect.succeed(Message.Completed()),
});
type Fixture = Readonly<{
  update: ReturnType<typeof makeWorkspaceUpdate>;
  refresh: Mock;
  more: Mock;
  retryMore: Mock;
  categoryCommand: Mock;
}>;
const setup = (): Fixture => {
  const refresh = vi.fn(() => complete({}));
  const more = vi.fn(() => complete({}));
  const retryMore = vi.fn(() => complete({}));
  const categoryCommand = vi.fn(() => complete({}));
  return {
    update: makeWorkspaceUpdate({ refresh, more, retryMore, category: categoryCommand }),
    refresh,
    more,
    retryMore,
    categoryCommand,
  };
};

it("preserves drafts during equivalent query emissions and clears account-owned state on identity changes", () => {
  const { update } = setup();
  const draft: Model = {
    ...ready,
    panel: "Capture",
    filters: { ...ready.filters, search: "private" },
    notice: "saved",
  };
  expect(update(draft, Message.ChangedQuery({ query: { ...ready.query } })).model).toEqual(draft);
  const refreshed = update(
    draft,
    Message.ChangedQuery({ query: { ...ready.query, generation: 1 } })
  ).model;
  expect(refreshed.panel).toBe("Summary");
  expect(refreshed.filters.search).toBe("private");
  const replaced = update(
    draft,
    Message.ChangedQuery({ query: { ...ready.query, user: Option.none() } })
  ).model;
  expect(replaced.filters.search).toBe("");
  expect(replaced.notice).toBe("");
  expect(replaced.panel).toBe("Summary");
});

it.each([
  Message.Filtered({ field: "search", value: "new" }),
  Message.ClearedFilters(),
  Message.Close(),
  Message.Opened({ id: record.id }),
  Message.Refresh(),
])("keeps a pending mutation intact on $_tag", (message) => {
  const fixture = setup();
  const pending: Model = { ...ready, working: true, panel: "Bulk", selection: [record.id] };
  expect(fixture.update(pending, message).model).toBe(pending);
  expect(fixture.refresh).not.toHaveBeenCalled();
});

it.each(["Summary", "Selecting", "Capture", "Bulk", "Correction", "Detail"] as const)(
  "only loads continuation from a safe %s panel",
  (panel) => {
    const fixture = setup();
    fixture.update({ ...ready, panel }, Message.More());
    fixture.update({ ...ready, panel }, Message.RetryMore());
    const expected = panel === "Summary" || panel === "Selecting" ? 1 : 0;
    expect(fixture.more).toHaveBeenCalledTimes(expected);
    expect(fixture.retryMore).toHaveBeenCalledTimes(expected);
    fixture.update({ ...ready, panel, working: true }, Message.More());
    fixture.update({ ...ready, panel, working: true }, Message.RetryMore());
    expect(fixture.more).toHaveBeenCalledTimes(expected);
    expect(fixture.retryMore).toHaveBeenCalledTimes(expected);
  }
);

it("bounds atomic selection, toggles rows, and requires a nonempty selection for bulk edit", () => {
  const { update } = setup();
  expect(update(ready, Message.ToggledSelection({ id: record.id })).model).toBe(ready);
  let model = update(ready, Message.SelectMany()).model;
  expect(model.panel).toBe("Selecting");
  expect(update(model, Message.EditSelection()).model).toBe(model);
  model = update(model, Message.ToggledSelection({ id: record.id })).model;
  expect(model.selection).toEqual([record.id]);
  expect(update(model, Message.EditSelection()).model.panel).toBe("Bulk");
  model = update(model, Message.ToggledSelection({ id: record.id })).model;
  expect(model.selection).toEqual([]);
  const full: Model = {
    ...model,
    selection: Array.from({ length: maximumAtomicBatchCalls }, (_, index) =>
      TransactionId.make(`24000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`)
    ),
  };
  expect(update(full, Message.ToggledSelection({ id: record.id })).model).toBe(full);
  expect(update(model, Message.SelectMany()).model.panel).toBe("Summary");
});

it.each(["Loading", "Failed"] as const)(
  "keeps a %s workspace readable without enabling edits",
  (status) => {
    const { update } = setup();
    const model: Model = { ...ready, query: { ...ready.query, status } };
    expect(update(model, Message.Opened({ id: record.id })).model.panel).toBe("Detail");
    for (const message of [
      Message.Capture(),
      Message.Edit(),
      Message.SelectMany(),
      Message.EditSelection(),
    ]) {
      expect(update(model, message).model).toBe(model);
    }
  }
);

it("validates category existence and revision, and prevents replay after an uncertain result", () => {
  const fixture = setup();
  fixture.update(ready, Message.ChangedCategory({ id: record.id, categoryId: category.id }));
  fixture.update(ready, Message.ChangedCategory({ id: record.id, categoryId: "missing" }));
  fixture.update(
    ready,
    Message.ChangedCategory({
      id: TransactionId.make("24000000-0000-4000-8000-000000000099"),
      categoryId: category.id,
    })
  );
  expect(fixture.categoryCommand).not.toHaveBeenCalled();
  const other = Schema.decodeSync(Category)({
    id: "24000000-0000-4000-8000-000000000004",
    label: "Otro",
  });
  const model: Model = { ...ready, query: { ...ready.query, categories: [category, other] } };
  expect(
    fixture.update(model, Message.ChangedCategory({ id: record.id, categoryId: other.id })).model
      .working
  ).toBe(true);
  expect(fixture.categoryCommand).toHaveBeenCalledExactlyOnceWith({
    id: record.id,
    categoryId: other.id,
    revision: 3,
  });
  const failed = fixture.update(model, Message.FailedCategory()).model;
  fixture.update(failed, Message.ChangedCategory({ id: record.id, categoryId: other.id }));
  expect(fixture.categoryCommand).toHaveBeenCalledTimes(1);
  const retry = fixture.update(failed, Message.Refresh()).model;
  expect(retry.feedback).toBe("");
  expect(fixture.refresh).toHaveBeenCalledTimes(1);
});

it("updates presentation choices and resets mutation state after canonical success", () => {
  const { update, refresh } = setup();
  let model = update(ready, Message.ToggledColumn({ column: "category" })).model;
  expect(model.categoryVisible).toBe(false);
  expect(model.typeVisible).toBe(true);
  model = update(model, Message.ToggledColumn({ column: "type" })).model;
  expect(model.typeVisible).toBe(false);
  model = update(model, Message.ToggledFilters()).model;
  expect(model.filtersVisible).toBe(true);
  model = update(model, Message.Sorted({ value: "counterpartyLabel:desc" })).model;
  expect(model.sort).toBe("counterpartyLabel:desc");
  model = update(model, Message.Filtered({ field: "search", value: "Tienda" })).model;
  expect(model.filters.search).toBe("Tienda");
  model = update(model, Message.ClearedFilters()).model;
  expect(model.filters.search).toBe("");
  model = update(model, Message.Capture()).model;
  expect(model.panel).toBe("Capture");
  model = update(model, Message.Close()).model;
  expect(model.panel).toBe("Summary");
  model = update(model, Message.Edit()).model;
  expect(model.panel).toBe("Correction");
  model = update(model, Message.ChangedWorking({ working: true })).model;
  model = update(model, Message.Saved({ notice: "2", title: "Guardado" })).model;
  expect(model.working).toBe(false);
  expect(model.panel).toBe("Summary");
  expect(model.noticeTitle).toBe("Guardado");
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(update(model, Message.Completed()).model).toBe(model);
  expect(update(model, Message.Mounted()).model).toBe(model);
});
