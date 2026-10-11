import { Effect, Option } from "effect";
import { Command } from "foldkit";
import { expect, it, vi } from "vitest";
import { WidgetId } from "@/transport/client";
import { Message, type Model, initialModel } from "./model";
import { ids, makeView, standardOptions } from "./test-fixtures";
import { makeDashboardUpdate } from "./workspace-update";

const containing = (value: Readonly<Record<string, unknown>>): unknown =>
  expect.objectContaining(value);

const complete = Command.define("DashboardTestCompleted", {
  args: {},
  messages: [Message.Completed],
  execute: () => Effect.succeed(Message.Completed()),
});
const setup = (): Readonly<{
  update: ReturnType<typeof makeDashboardUpdate>;
  edit: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}> => {
  const edit = vi.fn(() => complete({}));
  const refresh = vi.fn(() => complete({}));
  return { update: makeDashboardUpdate({ edit, refresh, refreshCatalog: refresh }), edit, refresh };
};
const ready: Model = {
  ...initialModel,
  editing: true,
  query: {
    ...initialModel.query,
    view: Option.some(makeView(standardOptions)),
    status: "Ready",
    waiting: false,
  },
};

it("does not rename when a read or selected Widget is unavailable", () => {
  const { update, edit } = setup();
  const missing = WidgetId.make("24000000-0000-4000-8000-000000000002");
  for (const model of [
    ready,
    { ...ready, renaming: Option.some(missing) },
    { ...ready, renaming: Option.some(ids.chart), query: initialModel.query },
  ]) {
    expect(update(model, Message.SaveTitle()).model).toBe(model);
  }
  expect(edit).not.toHaveBeenCalled();
});

it("rejects invalid names and compiles a trimmed name from the canonical nested Widget", () => {
  const { update, edit } = setup();
  const rename = { ...ready, renaming: Option.some(ids.chart), titleDraft: "  " };
  expect(update(rename, Message.SaveTitle()).model.error).toBe("Rejected");
  const saved = update({ ...rename, titleDraft: "  Nuevo título  " }, Message.SaveTitle()).model;
  expect(saved.submitting).toBe(true);
  expect(saved.renaming).toEqual(Option.none());
  expect(edit).toHaveBeenCalledWith({
    edit: containing({
      op: "update-widget",
      widget: containing({ id: ids.chart, title: "Nuevo título" }),
    }),
  });
});

it.each([
  { submitting: true },
  { editing: false },
  { error: "Uncertain" as const },
  { query: { ...ready.query, waiting: true } },
  { query: { ...ready.query, stale: true } },
  { query: { ...ready.query, status: "Failed" as const } },
])("locks edits and title drafts while canonical state is unavailable", (change) => {
  const { update, edit } = setup();
  const model = { ...ready, ...change };
  expect(
    update(model, Message.RequestedEdit({ edit: { op: "set-title", title: "Test" } })).model
  ).toBe(model);
  expect(update(model, Message.Rename({ id: ids.chart, title: "Test" })).model).toBe(model);
  expect(update(model, Message.ChangedTitle({ title: "Test" })).model).toBe(model);
  expect(edit).not.toHaveBeenCalled();
});

it("keeps pending edits intact and explicitly refreshes after an uncertain outcome", () => {
  const { update, refresh } = setup();
  const pending = { ...ready, submitting: true };
  expect(update(pending, Message.ToggleEditing()).model).toBe(pending);
  expect(update(pending, Message.Refresh()).model).toBe(pending);
  expect(refresh).not.toHaveBeenCalled();
  const uncertain = update(pending, Message.FailedEdit({ rejected: false })).model;
  expect(uncertain.error).toBe("Uncertain");
  const retry = update(uncertain, Message.Refresh()).model;
  expect(retry.error).toBe("None");
  expect(retry.query.waiting).toBe(true);
  expect(refresh).toHaveBeenCalledOnce();
  expect(update(pending, Message.FailedEdit({ rejected: true })).model.error).toBe("Rejected");
});

it("owns editing, cancellation, canonical refresh and catalog messages", () => {
  const { update, refresh } = setup();
  const renamed = update(ready, Message.Rename({ id: ids.chart, title: "Title" })).model;
  expect(update(renamed, Message.ChangedTitle({ title: "Draft" })).model.titleDraft).toBe("Draft");
  expect(update(renamed, Message.CancelTitle()).model.renaming).toEqual(Option.none());
  expect(update(renamed, Message.ToggleEditing()).model.editing).toBe(false);
  expect(update(ready, Message.InvalidEdit()).model.error).toBe("Rejected");
  expect(update(ready, Message.ChangedQuery({ query: initialModel.query })).model.query).toEqual(
    initialModel.query
  );
  expect(update(ready, Message.SavedEdit()).model.query.waiting).toBe(true);
  update(ready, Message.RefreshCatalog());
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(update(ready, Message.Completed()).model).toBe(ready);
  expect(update(ready, Message.Mounted()).model).toBe(ready);
});
