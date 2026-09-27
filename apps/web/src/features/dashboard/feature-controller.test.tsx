import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Cause, Effect, Array as EffectArray, Exit, Option, Schema } from "effect";
import { it as effectIt } from "@effect/vitest";
import { AsyncResult } from "effect/unstable/reactivity";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FidyClient } from "@/transport/client";
import { DashboardRouteContent } from "./feature";
import type { DashboardView } from "./presentation";
import type { DashboardEditor, DashboardEditorError } from "./view";

const atomHarness: {
  readonly applyEdit: ReturnType<typeof vi.fn>;
  readonly catalogResults: Array<unknown>;
  readonly editors: Array<DashboardEditor>;
} = vi.hoisted(() => ({ applyEdit: vi.fn(), catalogResults: [], editors: [] }));

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: (): (() => void) => () => undefined,
  useAtomSet: (): ReturnType<typeof vi.fn> => atomHarness.applyEdit,
  useAtomValue: (): unknown => Option.getOrThrow(EffectArray.get(atomHarness.catalogResults, 0)),
}));

vi.mock("./view", () => ({
  DashboardRouteContent: (): JSX.Element => <div>Presentación sin datos</div>,
  DashboardViewComponent: ({
    editor,
  }: Readonly<{ editor: Option.Option<DashboardEditor> }>): JSX.Element => {
    atomHarness.editors.push(Option.getOrThrow(editor));
    return <div>Canvas del tablero</div>;
  },
}));

const TestWidgetId = Schema.String.pipe(Schema.brand("WidgetId"));
const widgetId = Schema.decodeSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000901");
const view = Schema.decodeUnknownSync(
  Schema.declare((input: unknown): input is DashboardView => typeof input === "object")
)({});
const successResult = AsyncResult.success({ data: view });
const apiClient = Schema.decodeUnknownSync(
  Schema.declare(
    (input: unknown): input is FidyClient =>
      typeof input === "object" && input !== null && "query" in input && "runtime" in input
  )
)({
  query: vi.fn(() => ({ kind: "catalog-atom" })),
  runtime: { fn: vi.fn(() => vi.fn(() => ({ kind: "edit-atom" }))) },
});

const currentEditor = (): DashboardEditor =>
  Option.getOrThrow(EffectArray.last(atomHarness.editors));
const currentError = (): Option.Option<DashboardEditorError> => currentEditor().error;
const setCatalogResult = (result: unknown): void => {
  atomHarness.catalogResults.splice(0, atomHarness.catalogResults.length, result);
};

const waitForAssertion = (assertion: () => void): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => waitFor(assertion));

const triggerGesture = (gesture: Parameters<DashboardEditor["onGesture"]>[0]): void => {
  act(() => currentEditor().onGesture(gesture));
};
const expectRemoveApplied = (): void =>
  expect(atomHarness.applyEdit).toHaveBeenCalledWith({ op: "remove-widget", widgetId });
const expectEditSettled = (): void => expect(currentEditor().submitting).toBe(false);
const expectEditRejected = (): void =>
  expect(Option.getOrThrow(currentError()).title).toBe("No pudimos guardar el cambio");

const settleEdit = (
  pending: PromiseWithResolvers<Exit.Exit<unknown, unknown>>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    Promise.resolve(
      act(() => {
        pending.resolve(Exit.succeed({}));
        return Promise.resolve();
      })
    )
  );

beforeEach(() => {
  atomHarness.applyEdit.mockReset();
  atomHarness.applyEdit.mockResolvedValue(Exit.succeed({}));
  setCatalogResult(AsyncResult.success({ data: [] }));
  atomHarness.editors.splice(0);
});

afterEach(cleanup);

describe("Dashboard route resources", () => {
  it("distinguishes catalog failure from a stale Dashboard refresh", () => {
    setCatalogResult(AsyncResult.failure(Cause.fail("catalog")));
    const { unmount } = render(
      <DashboardRouteContent apiClient={apiClient} onRefresh={vi.fn()} result={successResult} />
    );
    expect(Option.getOrThrow(currentError()).title).toBe("No pudimos cargar el catálogo");
    unmount();

    setCatalogResult(AsyncResult.success({ data: [] }));
    const staleResult = AsyncResult.failure(Cause.fail("refresh"), {
      previousSuccess: Option.some(successResult),
    });
    render(
      <DashboardRouteContent apiClient={apiClient} onRefresh={vi.fn()} result={staleResult} />
    );
    expect(Option.getOrThrow(currentError()).title).toContain("se guardó");
  });
});

describe("Dashboard route edits", () => {
  effectIt.effect("queues a canonical edit and clears its pending state after success", () =>
    Effect.gen(function* () {
      const deferredEdit = Promise.withResolvers<Exit.Exit<unknown, unknown>>();
      atomHarness.applyEdit.mockReturnValueOnce(deferredEdit.promise);
      render(
        <DashboardRouteContent apiClient={apiClient} onRefresh={vi.fn()} result={successResult} />
      );

      triggerGesture({ kind: "remove-widget", widgetId });
      expect(currentEditor().submitting).toBe(true);
      yield* waitForAssertion(expectRemoveApplied);
      yield* settleEdit(deferredEdit);
      yield* waitForAssertion(expectEditSettled);
      expect(currentError()).toEqual(Option.none());
    })
  );

  effectIt.effect("reports schema rejection, canonical failure, and promise rejection safely", () =>
    Effect.gen(function* () {
      render(
        <DashboardRouteContent apiClient={apiClient} onRefresh={vi.fn()} result={successResult} />
      );
      triggerGesture({
        kind: "resize-region",
        widgetIds: [widgetId],
        weight: Number.NaN,
      });
      yield* waitForAssertion(expectEditRejected);

      atomHarness.applyEdit.mockResolvedValueOnce(Exit.fail(Cause.fail("rejected")));
      triggerGesture({ kind: "remove-widget", widgetId });
      yield* waitForAssertion(expectEditSettled);
      expectEditRejected();

      atomHarness.applyEdit.mockRejectedValueOnce(new Error("transport failed"));
      triggerGesture({ kind: "remove-widget", widgetId });
      yield* waitForAssertion(expectEditSettled);
      expectEditRejected();
    })
  );
});
