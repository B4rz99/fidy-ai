import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { type Cause, DateTime, Effect, Layer, Option } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse, UrlParams } from "effect/http";
import { afterEach, expect, it } from "vitest";
import { createWebRouter } from "@/app/routes";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient, makeHostedTurnClient, makeWebAuthClient } from "@/transport/client";

const attempt = "10000000-0000-4000-8000-000000000001";
const attemptLifetimeMilliseconds = 600000;
const review = {
  connection: {
    id: "10000000-0000-4000-8000-000000000002",
    institutionId: "bancolombia",
    state: "Connecting",
  },
  institutionName: "Bancolombia",
  expiresAt: DateTime.formatIso(
    DateTime.makeUnsafe(DateTime.nowUnsafe().epochMilliseconds + attemptLifetimeMilliseconds)
  ),
  phase: "ready",
};
type Reply = Readonly<{ body: unknown; status: number }>;
const show = (path: string, reply: (method: string, url: string) => Reply): void => {
  const httpClient = HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (work) =>
      Effect.flatMap(work, (request) => {
        const query = UrlParams.toString(request.urlParams);
        const response = reply(
          request.method,
          query.length === 0 ? request.url : `${request.url}?${query}`
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(response.body, { status: response.status })
          )
        );
      }),
    Effect.succeed
  );
  const options = {
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
  };
  const router = createWebRouter({
    apiClient: makeFidyClient(options),
    webAuthClient: makeWebAuthClient(options),
    hostedTurnClient: makeHostedTurnClient(options),
    history: Option.some(createMemoryHistory({ initialEntries: [path] })),
  });
  render(
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
};
afterEach(cleanup);
const wait = <A,>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const loginTestDeadlineMilliseconds = 10000;
const verifierLength = 43;

it(
  "returns verified browser login to the fixed Connection route without beginning authorization",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const calls: string[] = [];
        show(`/auth/pair?connectionAttempt=${attempt}`, (method, url) => {
          calls.push(`${method} ${url}`);
          if (url.endsWith("/web/pairings")) {
            return {
              status: 200,
              body: {
                pairingId: "10000000-0000-4000-8000-000000000003",
                privateVerifier: "v".repeat(verifierLength),
                publicCode: "BCDF-GHJK",
                expiresAt: review.expiresAt,
                pollingIntervalSeconds: 5,
              },
            };
          }
          if (url.endsWith("/web/pairings/redeem")) {
            return { status: 200, body: { status: "authenticated" } };
          }
          return { status: 200, body: { ...review, phase: "prepared" } };
        });
        fireEvent.click(
          yield* wait(screen.findByRole("button", { name: "Iniciar sesión en el navegador" }))
        );
        expect(yield* wait(screen.findByText("BCDF-GHJK"))).toBeVisible();
        expect(
          yield* wait(
            screen.findByText(
              "Conexión pendiente de autorización",
              {},
              { timeout: loginTestDeadlineMilliseconds }
            )
          )
        ).toBeVisible();
        expect(calls).toEqual([
          "POST https://api.fidyapp.com/web/pairings",
          "POST https://api.fidyapp.com/web/pairings/redeem",
          `GET https://api.fidyapp.com/web/connections/review?attempt=${attempt}`,
        ]);
      })
    ),
  loginTestDeadlineMilliseconds
);

it("disables preparation when the original attempt deadline has passed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const calls: string[] = [];
      show(`/connections/continue?attempt=${attempt}`, (method) => {
        calls.push(method);
        return { body: { ...review, expiresAt: "2020-01-01T00:00:00.000Z" }, status: 200 };
      });
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent("La solicitud venció.");
      expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
      expect(calls).toEqual(["GET"]);
    })
  ));

it("reviews the advertised browser route and prepares only on an explicit click", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const calls: string[] = [];
      let prepared = false;
      show(`/connections/continue?attempt=${attempt}`, (method, url) => {
        calls.push(`${method} ${url}`);
        if (method === "POST") prepared = true;
        return {
          body: {
            ...review,
            phase: prepared ? "prepared" : "ready",
          },
          status: 200,
        };
      });
      const button = yield* wait(screen.findByRole("button", { name: "Continuar" }));
      expect(calls).toEqual([
        `GET https://api.fidyapp.com/web/connections/review?attempt=${attempt}`,
      ]);
      fireEvent.click(button);
      expect(yield* wait(screen.findByText("Conexión pendiente de autorización"))).toBeVisible();
      expect(
        screen.getByText(/La autorización con Bancolombia todavía no está disponible/)
      ).toBeVisible();
      expect(calls).toHaveLength(3);
      expect(calls[1]).toBe("POST https://api.fidyapp.com/web/connections/begin");
      expect(screen.queryByRole("button", { name: "Continuar" })).not.toBeInTheDocument();
    })
  ));

it("refuses malformed public references before making any request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const calls: string[] = [];
      show("/connections/continue?attempt=invalid", (method, url) => {
        calls.push(`${method} ${url}`);
        return { body: review, status: 200 };
      });
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "La solicitud no es válida."
      );
      expect(calls).toEqual([]);
    })
  ));

it("offers same-reference sign-in when the continuation cannot be reviewed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      show(`/connections/continue?attempt=${attempt}`, () => ({
        body: { error: { code: "continuation_unavailable" } },
        status: 401,
      }));
      expect(yield* wait(screen.findByRole("link", { name: "Iniciar sesión" }))).toHaveAttribute(
        "href",
        `/auth/pair?connectionAttempt=${attempt}`
      );
      expect(screen.queryByRole("button", { name: "Continuar" })).not.toBeInTheDocument();
    })
  ));

it("does not replay an uncertain preparation and recovers progress by review", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const methods: string[] = [];
      show(`/connections/continue?attempt=${attempt}`, (method) => {
        methods.push(method);
        return method === "POST"
          ? { body: { error: { code: "continuation_unavailable" } }, status: 503 }
          : { body: { ...review, phase: methods.length > 1 ? "prepared" : "ready" }, status: 200 };
      });
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Continuar" })));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "No pudimos confirmar el resultado."
      );
      expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Consultar estado" }));
      expect(yield* wait(screen.findByText("Conexión pendiente de autorización"))).toBeVisible();
      expect(methods).toEqual(["GET", "POST", "GET"]);
    })
  ));
