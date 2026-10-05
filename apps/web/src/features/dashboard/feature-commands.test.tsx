import { RegistryProvider } from "@effect/atom-react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type Cause, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { AsyncResult } from "effect/reactivity";
import type { JSX } from "react";
import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { makeFidyClient } from "@/transport/client";
import { DashboardRouteContent } from "./feature";
import type { DashboardView } from "./presentation";
import type { DashboardEditor } from "./view";

// Substitute only the canvas; command ownership and the generated transport are real.
vi.mock("./view", () => ({
  DashboardRouteContent: (): JSX.Element => <div />,
  DashboardViewComponent: ({
    editor,
  }: Readonly<{ editor: Option.Option<DashboardEditor> }>): JSX.Element => {
    const current = Option.getOrThrow(editor);
    return (
      <>
        <button
          disabled={current.submitting}
          onClick={() =>
            current.onGesture({
              kind: "remove-widget",
              widgetId: Schema.decodeSync(Schema.String.pipe(Schema.brand("WidgetId")))(
                "f1d1a000-0000-4000-8000-000000000901"
              ),
            })
          }
        >
          Quitar widget
        </button>
        {Option.isSome(current.error) ? (
          <div role="alert">
            {current.error.value.title} {current.error.value.message}
            {Option.match(current.error.value.onRefresh, {
              onNone: () => null,
              onSome: (refresh) => <button onClick={refresh}>Actualizar tablero</button>,
            })}
          </div>
        ) : null}
      </>
    );
  },
}));

afterEach(cleanup);

type ResponseCase = Readonly<{ name: string; response: () => Response }>;
const responseCases: ReadonlyArray<ResponseCase> = [
  { name: "lost response", response: (): Response => new Response(null, { status: 503 }) },
  {
    name: "malformed response",
    response: (): Response =>
      new Response("{", { headers: { "content-type": "application/json" } }),
  },
];

const makeTransport = (response: () => Response, commit: () => void): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (effect) =>
      Effect.flatMap(effect, (request) => {
        const editing = new URL(request.url).pathname === "/dashboard/edits";
        if (editing) commit();
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            editing ? response() : Response.json({ data: [], next: [] })
          )
        );
      }),
    Effect.succeed
  );

const waitForUncertainty = (): Promise<void> =>
  waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("No pudimos confirmar el cambio")
  );

const assertUncertainAcknowledgement = ({
  response,
}: ResponseCase): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    let committed = 0;
    const httpClient = makeTransport(response, () => {
      committed += 1;
    });
    const client = makeFidyClient({
      apiOrigin: "https://api.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
    });
    const refresh = vi.fn();
    const view = yield* Schema.decodeUnknownEffect(
      Schema.declare(
        (value: unknown): value is DashboardView => typeof value === "object" && value !== null
      )
    )({});
    render(
      <RegistryProvider>
        <DashboardRouteContent
          apiClient={client}
          onRefresh={refresh}
          phase="reading"
          result={AsyncResult.success({ data: view })}
        />
      </RegistryProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Quitar widget" }));
    yield* Effect.tryPromise(waitForUncertainty);
    expect(screen.getByRole("alert").textContent).not.toContain("fue rechazado");
    expect(committed).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar tablero" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(committed).toBe(1);
  });

it.effect.each(responseCases)(
  "offers inspection, not a replay, when an accepted Dashboard edit has a $name",
  assertUncertainAcknowledgement
);
