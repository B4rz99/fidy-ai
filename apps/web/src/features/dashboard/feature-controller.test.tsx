import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Cause, Effect, Array as EffectArray, Exit, Option, Schema } from "effect";
import { it as effectIt } from "@effect/vitest";
import { AsyncResult } from "effect/reactivity";
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
      <DashboardRouteContent
        apiClient={apiClient}
        onRefresh={vi.fn()}
        result={successResult}
        phase="reading"
      />
    );
    expect(Option.getOrThrow(currentError()).title).toBe("No pudimos cargar el catálogo");
    unmount();

    setCatalogResult(AsyncResult.success({ data: [] }));
    const staleResult = AsyncResult.failure(Cause.fail("refresh"), {
      previousSuccess: Option.some(successResult),
    });
    render(
      <DashboardRouteContent
        apiClient={apiClient}
        onRefresh={vi.fn()}
        result={staleResult}
        phase="reading"
      />
    );
    expect(Option.getOrThrow(currentError()).title).toContain("se guardó");
  });
});

const renderEditableDashboard = (): ReturnType<typeof render> =>
  render(
    <DashboardRouteContent
      apiClient={apiClient}
      onRefresh={vi.fn()}
      result={successResult}
      phase="reading"
    />
  );

describe("Dashboard stale edits", () => {
  effectIt.effect("offers a canonical refresh when an edited Widget is no longer available", () =>
    Effect.gen(function* () {
      atomHarness.applyEdit.mockResolvedValueOnce(
        Exit.fail({
          _tag: "NotFound",
          error: { code: "not_found", message: "Unavailable" },
          next: [],
        })
      );
      renderEditableDashboard();
      triggerGesture({ kind: "remove-widget", widgetId });
      yield* waitForAssertion(expectEditSettled);
      const error = Option.getOrThrow(currentError());
      expect(error.message).toContain("ya no está disponible");
      expect(Option.isSome(error.onRefresh)).toBe(true);
    })
  );
});

describe("Dashboard route edits", () => {
  effectIt.effect("keeps a successful edit pending until the canonical reread", () =>
    Effect.gen(function* () {
      const deferredEdit = Promise.withResolvers<Exit.Exit<unknown, unknown>>();
      atomHarness.applyEdit.mockReturnValueOnce(deferredEdit.promise);
      const rendered = renderEditableDashboard();

      triggerGesture({ kind: "remove-widget", widgetId });
      expect(currentEditor().submitting).toBe(true);
      yield* waitForAssertion(expectRemoveApplied);
      yield* settleEdit(deferredEdit);
      expect(currentEditor().submitting).toBe(true);
      rendered.rerender(
        <DashboardRouteContent
          apiClient={apiClient}
          onRefresh={vi.fn()}
          result={AsyncResult.success({ data: { ...view } })}
          phase="reading"
        />
      );
      yield* waitForAssertion(expectEditSettled);
      expect(currentError()).toEqual(Option.none());
    })
  );

  effectIt.effect(
    "distinguishes local validation and declared refusals from an uncertain promise rejection",
    () =>
      Effect.gen(function* () {
        renderEditableDashboard();
        triggerGesture({
          kind: "resize-region",
          widgetIds: [widgetId],
          weight: Number.NaN,
        });
        yield* waitForAssertion(expectEditRejected);

        atomHarness.applyEdit.mockResolvedValueOnce(
          Exit.fail({
            _tag: "ValidationFailed",
            error: { code: "validation_failed", message: "Refused", fields: [] },
            next: [],
          })
        );
        triggerGesture({ kind: "remove-widget", widgetId });
        yield* waitForAssertion(expectEditSettled);
        expectEditRejected();

        atomHarness.applyEdit.mockRejectedValueOnce(new Error("transport failed"));
        triggerGesture({ kind: "remove-widget", widgetId });
        yield* waitForAssertion(expectEditSettled);
        expect(Option.getOrThrow(currentError()).title).toBe("No pudimos confirmar el cambio");
        expect(Option.getOrThrow(currentError()).message).not.toContain("transport failed");
      })
  );
});
