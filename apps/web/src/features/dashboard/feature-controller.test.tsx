import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Cause, Array as EffectArray, Exit, Option, Schema } from "effect";
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
const widgetId = Schema.decodeUnknownSync(TestWidgetId)("f1d1a000-0000-4000-8000-000000000901");
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

beforeEach(() => {
  atomHarness.applyEdit.mockReset();
  atomHarness.applyEdit.mockResolvedValue(Exit.succeed({}));
  setCatalogResult(AsyncResult.success({ data: [] }));
  atomHarness.editors.splice(0);
});

afterEach(cleanup);

describe("Dashboard route resources", () => {
  it("delegates initial failures to the resource presentation", () => {
    render(
      <DashboardRouteContent
        apiClient={apiClient}
        onRefresh={vi.fn()}
        result={AsyncResult.initial()}
      />
    );
    expect(screen.getByText("Presentación sin datos")).toBeVisible();
  });

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
    const onRefresh = vi.fn();
    render(
      <DashboardRouteContent apiClient={apiClient} onRefresh={onRefresh} result={staleResult} />
    );
    expect(Option.getOrThrow(currentError()).title).toContain("se guardó");
    fireEvent.click(screen.getByRole("button", { name: "Reintentar actualización del tablero" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("Dashboard route edits", () => {
  it("queues a canonical edit and clears its pending state after success", async () => {
    const deferredEdit = Promise.withResolvers<Exit.Exit<unknown, unknown>>();
    atomHarness.applyEdit.mockReturnValueOnce(deferredEdit.promise);
    render(
      <DashboardRouteContent apiClient={apiClient} onRefresh={vi.fn()} result={successResult} />
    );

    act(() => currentEditor().onGesture({ kind: "remove-widget", widgetId }));
    expect(currentEditor().submitting).toBe(true);
    await waitFor(() =>
      expect(atomHarness.applyEdit).toHaveBeenCalledWith({ op: "remove-widget", widgetId })
    );
    await act(async () => deferredEdit.resolve(Exit.succeed({})));
    await waitFor(() => expect(currentEditor().submitting).toBe(false));
    expect(currentError()).toEqual(Option.none());
  });

  it("reports schema rejection, canonical failure, and promise rejection safely", async () => {
    render(
      <DashboardRouteContent apiClient={apiClient} onRefresh={vi.fn()} result={successResult} />
    );
    act(() =>
      currentEditor().onGesture({
        kind: "resize-region",
        widgetIds: [widgetId],
        weight: Number.NaN,
      })
    );
    await waitFor(() =>
      expect(Option.getOrThrow(currentError()).title).toBe("No pudimos guardar el cambio")
    );

    atomHarness.applyEdit.mockResolvedValueOnce(Exit.fail(Cause.fail("rejected")));
    act(() => currentEditor().onGesture({ kind: "remove-widget", widgetId }));
    await waitFor(() => expect(currentEditor().submitting).toBe(false));
    expect(Option.getOrThrow(currentError()).title).toBe("No pudimos guardar el cambio");

    atomHarness.applyEdit.mockRejectedValueOnce(new Error("transport failed"));
    act(() => currentEditor().onGesture({ kind: "remove-widget", widgetId }));
    await waitFor(() => expect(currentEditor().submitting).toBe(false));
    expect(Option.getOrThrow(currentError()).title).toBe("No pudimos guardar el cambio");
  });
});
