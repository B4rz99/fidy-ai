import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { type Cause, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { DashboardView, makeFidyClient } from "@/transport/client";
import { mountDashboard } from "./program";
import { catalog, ids, makeView, standardOptions } from "./test-fixtures";

const encodeView = Schema.encodeSync(DashboardView);
const decodeBody = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
type Respond = (request: Readonly<{ path: string; method: string; body: unknown }>) => Response;
const ordinary = (path: string): Response =>
  Response.json({
    data: path === "/dashboard/view" ? encodeView(makeView(standardOptions)) : catalog,
    next: [],
  });
const mount = (respond: Respond): ReturnType<typeof renderFoldkit> => {
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            respond({
              path: new URL(request.url).pathname,
              method: request.method,
              body:
                request.body._tag === "Uint8Array"
                  ? decodeBody(new TextDecoder().decode(request.body.body))
                  : null,
            })
          )
        )
      )
    ),
  });
  const registry = AtomRegistry.make();
  return renderFoldkit((container) => {
    const dispose = mountDashboard({
      container,
      client,
      registry,
      resources: registry.get(client.runtime.layer),
    });
    return (): void => {
      dispose();
      registry.dispose();
    };
  });
};
const click = (name: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => screen.findByRole("button", { name })).pipe(
    Effect.flatMap((button) =>
      Effect.tryPromise(() => waitFor(() => expect(button).not.toBeDisabled())).pipe(
        Effect.tap(() => Effect.sync(() => fireEvent.click(button)))
      )
    ),
    Effect.asVoid
  );
const verticalBoundary = (): Promise<Option.Option<HTMLElement>> =>
  screen
    .findAllByRole("separator", { name: "Redimensionar límite después de Transacciones" })
    .then((separators) =>
      Option.fromUndefinedOr(
        separators.find((separator) => separator.getAttribute("aria-orientation") === "vertical")
      )
    );
afterEach(cleanupFoldkit);
it("renders all canonical Widget variants with responsive splits and exact totals", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mount(({ path }) => ordinary(path));
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Presupuesto" }));
      expect(screen.getByRole("img", { name: "Gastos en COP" })).toBeInTheDocument();
      expect(screen.getByRole("table", { name: "Transacciones del Widget" })).toHaveTextContent(
        "El Corral"
      );
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
      expect(screen.getByText("Promedio mensual")).toBeInTheDocument();
      expect(document.querySelector('[data-testid="responsive-weight-2"]')).toHaveStyle({
        "--dashboard-weight": "2",
      });
    })
  ));
it("saves a trimmed Widget title through the canonical operation and rereads the canvas", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      let reads = 0;
      mount(({ path, body }) => {
        if (path === "/dashboard/view") reads++;
        if (path === "/dashboard/edits") {
          edits.push(body);
          return Response.json({
            data: {
              title: "Mi tablero",
              layout: {
                kind: "leaf",
                widget: {
                  id: ids.chart,
                  type: "spending-chart",
                  groupBy: "category",
                  period: "this-month",
                },
              },
            },
            next: [],
          });
        }
        return ordinary(path);
      });
      yield* click("Personalizar");
      yield* click("Renombrar Transacciones");
      const input = yield* Effect.tryPromise(() =>
        screen.findByRole("textbox", { name: "Nuevo nombre del Widget" })
      );
      fireEvent.input(input, { target: { value: "  Mis gastos  " } });
      yield* click("Guardar nombre del Widget");
      yield* Effect.tryPromise(() => waitFor(() => expect(edits).toHaveLength(1)));
      expect(edits[0]).toMatchObject({
        op: "update-widget",
        widget: { id: ids.chart, title: "Mis gastos" },
      });
      yield* Effect.tryPromise(() => waitFor(() => expect(reads).toBeGreaterThan(1)));
    })
  ));
for (const kind of ["lost", "malformed"] as const) {
  it(`blocks edits after a ${kind} acknowledgement until an explicit read`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let edits = 0;
        mount(({ path }) => {
          if (path === "/dashboard/edits") {
            edits++;
            return kind === "lost"
              ? new Response(null, { status: 503 })
              : new Response("{", { headers: { "content-type": "application/json" } });
          }
          return ordinary(path);
        });
        yield* click("Personalizar");
        yield* click("Eliminar Transacciones");
        yield* Effect.tryPromise(() => screen.findByText("No pudimos confirmar el cambio"));
        expect(edits).toBe(1);
        expect(screen.getByRole("button", { name: "Eliminar Presupuesto" })).toBeDisabled();
        yield* click("Actualizar tablero");
        yield* Effect.tryPromise(() =>
          waitFor(() =>
            expect(screen.getByRole("button", { name: "Eliminar Presupuesto" })).not.toBeDisabled()
          )
        );
        expect(edits).toBe(1);
      })
    ));
}
it("preserves a stale canvas while disabling edits after refresh failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      mount(({ path }) => {
        if (path === "/dashboard/view" && ++reads > 1) return new Response(null, { status: 503 });
        if (path === "/dashboard/edits") {
          return Response.json({
            data: {
              title: "Mi tablero",
              layout: {
                kind: "leaf",
                widget: {
                  id: ids.chart,
                  type: "spending-chart",
                  groupBy: "category",
                  period: "this-month",
                },
              },
            },
            next: [],
          });
        }
        return ordinary(path);
      });
      yield* click("Personalizar");
      yield* click("Eliminar Transacciones");
      yield* Effect.tryPromise(() =>
        screen.findByText(
          "No pudimos actualizar el tablero. Mostramos el último tablero disponible."
        )
      );
      expect(screen.getByRole("heading", { name: "Presupuesto" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Eliminar Presupuesto" })).toBeDisabled();
    })
  ));
it("exposes generic feedback when a response is malformed and never initializes on a transport failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const paths: Array<string> = [];
      mount(({ path }) => {
        paths.push(path);
        return path === "/dashboard/view"
          ? new Response("private invalid response", {
              headers: { "content-type": "application/json" },
            })
          : ordinary(path);
      });
      yield* Effect.tryPromise(() => screen.findByText("No pudimos comunicarnos con Fidy"));
      expect(document.body.textContent).not.toContain("private invalid response");
      expect(paths).not.toContain("/dashboard/initialize");
    })
  ));
it("cancels title editing with Escape and disables an empty title without a mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let edits = 0;
      mount(({ path }) => {
        if (path === "/dashboard/edits") edits++;
        return ordinary(path);
      });
      yield* click("Personalizar");
      yield* click("Renombrar Transacciones");
      const input = yield* Effect.tryPromise(() =>
        screen.findByRole("textbox", { name: "Nuevo nombre del Widget" })
      );
      fireEvent.input(input, { target: { value: "   " } });
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(screen.getByRole("button", { name: "Guardar nombre del Widget" })).toBeDisabled()
        )
      );
      fireEvent.keyDown(input, { key: "Escape" });
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(screen.queryByRole("textbox", { name: "Nuevo nombre del Widget" })).toBeNull()
        )
      );
      expect(edits).toBe(0);
    })
  ));
it("resizes one recursive boundary by keyboard through one canonical edit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      mount(({ path, body }) => {
        if (path === "/dashboard/edits") {
          edits.push(body);
          return Response.json({
            data: {
              title: "Mi tablero",
              layout: {
                kind: "leaf",
                widget: {
                  id: ids.chart,
                  type: "spending-chart",
                  groupBy: "category",
                  period: "this-month",
                },
              },
            },
            next: [],
          });
        }
        return ordinary(path);
      });
      yield* click("Personalizar");
      const separator = yield* Effect.tryPromise(verticalBoundary);
      if (Option.isNone(separator)) throw new Error("Missing vertical resize boundary");
      fireEvent.keyDown(separator.value, { key: "ArrowRight" });
      yield* Effect.tryPromise(() => waitFor(() => expect(edits).toHaveLength(1)));
      expect(edits[0]).toMatchObject({
        op: "resize-region",
        widgetIds: [ids.chart, ids.budget],
        size: { kind: "weight", weight: 2.15 },
      });
    })
  ));
it("keeps catalog failure independent from a usable Dashboard and retries only the catalog", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let catalogReads = 0;
      let dashboardReads = 0;
      mount(({ path }) => {
        if (path === "/dashboard/catalog") {
          catalogReads++;
          if (catalogReads === 1) return new Response(null, { status: 503 });
        }
        if (path === "/dashboard/view") dashboardReads++;
        return ordinary(path);
      });
      yield* click("Personalizar");
      yield* Effect.tryPromise(() =>
        screen.findByText("No pudimos cargar el catálogo. Los demás controles siguen disponibles.")
      );
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(screen.getByRole("button", { name: "Eliminar Presupuesto" })).not.toBeDisabled()
        )
      );
      expect(dashboardReads).toBe(1);
      const readsBeforeRetry = dashboardReads;
      yield* click("Reintentar carga del catálogo");
      yield* Effect.tryPromise(() => waitFor(() => expect(catalogReads).toBe(2)));
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Arrastrar Gastos del mes" })
      );
      expect(
        screen.queryByText("No pudimos cargar el catálogo. Los demás controles siguen disponibles.")
      ).toBeNull();
      expect(dashboardReads).toBe(readsBeforeRetry);
    })
  ));
