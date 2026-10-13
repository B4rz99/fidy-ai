import { RegistryProvider } from "@effect/atom-react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { it } from "@effect/vitest";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { afterEach, expect, vi } from "vitest";
import { type JSX, StrictMode } from "react";
import { WidgetId, makeFidyClient } from "@/transport/client";
import type { CanonicalQueryState } from "@/transport/canonical-query";
import { useDashboardEditing } from "./editing";
import type { DashboardView } from "./presentation";

const transactionLimit = 5;
const widgetId = WidgetId.make("f1d1a000-0000-4000-8000-000000000901");
const view: DashboardView = {
  title: Schema.decodeSync(Schema.NonEmptyString)("Mi tablero"),
  context: {
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: Schema.decodeSync(Schema.String.pipe(Schema.brand("IanaTimeZone")))("America/Bogota"),
    calculatedAt: DateTime.makeUnsafe("2026-10-01T14:00:00Z"),
  },
  layout: {
    kind: "leaf",
    widget: {
      widget: {
        id: widgetId,
        type: "transaction-list",
        limit: Schema.decodeSync(Schema.Finite.pipe(Schema.brand("TransactionListLimit")))(
          transactionLimit
        ),
      },
      result: { transactions: [] },
    },
  },
};
type Query = CanonicalQueryState<Readonly<{ data: DashboardView }>, unknown>;
const ready = (data: DashboardView): Query => ({
  _tag: "Ready",
  value: { data },
  waiting: false,
  refreshFailure: Option.none(),
});
const success = (): Response =>
  Response.json({
    data: {
      title: "Mi tablero",
      layout: {
        kind: "leaf",
        widget: { id: widgetId, type: "transaction-list", limit: transactionLimit },
      },
    },
    next: [],
  });
const Harness = ({
  query,
  apiClient,
  refresh,
}: Readonly<{
  query: Query;
  apiClient: ReturnType<typeof makeFidyClient>;
  refresh: () => void;
}>): JSX.Element => {
  const { lifecycleRef, ...editing } = useDashboardEditing({
    apiClient,
    onRefresh: refresh,
    dashboard: query,
  });
  const remove = (): void => editing.onGesture({ kind: "remove-widget", widgetId });
  return (
    <div ref={lifecycleRef}>
      <button disabled={editing.disabled} onClick={remove}>
        Editar
      </button>
      <button
        onClick={() => {
          remove();
          remove();
        }}
      >
        Dos cambios simultáneos
      </button>
      <button
        onClick={() =>
          editing.onGesture({ kind: "resize-region", widgetIds: [widgetId], weight: Number.NaN })
        }
      >
        Inválido
      </button>
      <output>{editing.submitting ? "Guardando" : "Finalizado"}</output>
      {Option.isSome(editing.pendingPlacement) ? <p>Distribución provisional</p> : null}
      {Option.isSome(editing.editError) ? (
        <div role="alert">
          {editing.editError.value.title}
          {Option.match(editing.editError.value.onRefresh, {
            onNone: () => null,
            onSome: (retry) => <button onClick={retry}>Actualizar</button>,
          })}
        </div>
      ) : null}
    </div>
  );
};
type Mounted = ReturnType<typeof render> &
  Readonly<{
    calls: () => number;
    refresh: ReturnType<typeof vi.fn>;
    update: (query: Query) => void;
    replace: () => void;
  }>;
const mount = (response: () => Effect.Effect<Response>): Mounted => {
  let calls = 0;
  const refresh = vi.fn();
  const transport = HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (effect) =>
      Effect.flatMap(effect, (request) => {
        calls += 1;
        return response().pipe(Effect.map((value) => HttpClientResponse.fromWeb(request, value)));
      }),
    Effect.succeed
  );
  const apiClient = makeFidyClient({
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, transport),
  });
  const content = (query: Query, key = "initial"): JSX.Element => (
    <StrictMode>
      <RegistryProvider>
        <Harness key={key} query={query} apiClient={apiClient} refresh={refresh} />
      </RegistryProvider>
    </StrictMode>
  );
  const rendered = render(content(ready(view)));
  return {
    ...rendered,
    calls: (): number => calls,
    refresh,
    update: (query: Query): void => rendered.rerender(content(query)),
    replace: (): void => rendered.rerender(content(ready(view), "replacement")),
  };
};
afterEach(cleanup);

it.effect(
  "keeps a saved edit pending until canonical reread, then releases the controls",
  Effect.fnUntraced(function* () {
    const mounted = mount(() => Effect.sync(success));
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    yield* Effect.tryPromise(() => waitFor(() => expect(mounted.calls()).toBe(1)));
    expect(screen.getByText("Guardando")).toBeVisible();
    expect(screen.getByText("Distribución provisional")).toBeVisible();
    mounted.update(ready({ ...view }));
    yield* Effect.tryPromise(() =>
      waitFor(() => expect(screen.getByRole("button", { name: "Editar" })).toBeEnabled())
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  })
);

it.effect(
  "discards queued edits after uncertainty and requires an explicit successful refresh",
  Effect.fnUntraced(function* () {
    const mounted = mount(() => Effect.succeed(new Response(null, { status: 503 })));
    fireEvent.click(screen.getByRole("button", { name: "Dos cambios simultáneos" }));
    yield* Effect.tryPromise(() => screen.findByText("No pudimos confirmar el cambio"));
    expect(mounted.calls()).toBe(1);
    expect(screen.getByRole("button", { name: "Editar" })).toBeDisabled();
    mounted.update(ready({ ...view }));
    expect(screen.getByRole("button", { name: "Editar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(mounted.refresh).toHaveBeenCalledOnce();
    mounted.update({
      ...ready(view),
      _tag: "Ready",
      value: { data: view },
      waiting: false,
      refreshFailure: Option.some({ _tag: "BoundaryFailure" }),
    });
    expect(screen.getByRole("button", { name: "Editar" })).toBeDisabled();
    mounted.update(ready({ ...view }));
    expect(screen.getByRole("button", { name: "Editar" })).toBeEnabled();
    expect(mounted.calls()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    yield* Effect.tryPromise(() => waitFor(() => expect(mounted.calls()).toBe(2)));
  })
);

it.effect(
  "discards unsent edits when the route owner departs, without undoing an in-flight mutation",
  Effect.fnUntraced(function* () {
    const pending = Promise.withResolvers<Response>();
    const mounted = mount(() => Effect.tryPromise(() => pending.promise).pipe(Effect.orDie));
    fireEvent.click(screen.getByRole("button", { name: "Dos cambios simultáneos" }));
    yield* Effect.tryPromise(() => waitFor(() => expect(mounted.calls()).toBe(1)));
    mounted.replace();
    pending.resolve(success());
    yield* Effect.tryPromise(() =>
      waitFor(() => expect(screen.getByRole("button", { name: "Editar" })).toBeEnabled())
    );
    expect(mounted.calls()).toBe(1);
    expect(screen.queryByText("Distribución provisional")).not.toBeInTheDocument();
  })
);

it.effect(
  "rejects invalid gestures locally and distinguishes declared refusal from uncertainty",
  Effect.fnUntraced(function* () {
    const mounted = mount(() =>
      Effect.succeed(
        Response.json(
          { error: { code: "validation_failed", message: "Refused", fields: [] }, next: [] },
          { status: 400 }
        )
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Inválido" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos guardar el cambio");
    expect(mounted.calls()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    yield* Effect.tryPromise(() => waitFor(() => expect(mounted.calls()).toBe(1)));
    yield* Effect.tryPromise(() => screen.findByText("No pudimos guardar el cambio"));
    expect(screen.getByRole("button", { name: "Editar" })).toBeEnabled();
  })
);

it.effect(
  "requires a canonical refresh when the edited Widget no longer exists",
  Effect.fnUntraced(function* () {
    mount(() =>
      Effect.succeed(
        Response.json(
          { error: { code: "not_found", message: "Unavailable" }, next: [] },
          { status: 404 }
        )
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    yield* Effect.tryPromise(() => screen.findByText("Actualiza el tablero"));
    expect(screen.getByRole("button", { name: "Actualizar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Editar" })).toBeDisabled();
  })
);
