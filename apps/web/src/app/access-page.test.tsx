import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type Cause, Clock, Duration, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { afterEach, expect, it } from "vitest";
import { StrictMode } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient, makeWebAuthClient } from "@/transport/client";
import { AccessManagementPage } from "./access-page";

const unauthorizedStatus = 401;
const successStatus = 200;
const testLifetimeDays = 7;
const handoffMinutes = 20;
const connectionId = "10000000-0000-4000-8000-000000000001";
const pat = {
  shortId: "sample01",
  recipientLabel: "Mi token",
  scopes: ["read"],
  createdAt: "2026-10-01T14:00:00Z",
  lastUsedAt: null,
  expiresAt: "2026-12-30T14:00:00Z",
};
const connection = {
  connectionId,
  claimedClientName: "Mi conexión MCP",
  scopes: ["read"],
  permissions: [{ scope: "read", label: "Lectura", description: "Consultar datos" }],
  expiresAt: "2026-12-30T14:00:00Z",
  state: "active",
  recentActivity: [],
};
const responseBody = (url: string, method: string, userId: string): unknown => {
  const tokens = url.includes("/pats");
  let body: unknown = { revoked: true };
  if (url.includes("/user")) {
    body = {
      data: {
        id: userId,
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/Bogota",
        trialPeriod: { startedAt: "2026-10-01T14:00:00Z", endsAt: "2026-10-08T14:00:00Z" },
        createdAt: "2026-10-01T14:00:00Z",
      },
      next: [],
    };
  } else if (tokens) {
    body = { data: { pats: [pat] }, next: [] };
  } else if (method === "GET") {
    body = {
      connections: [connection],
      nextCursor: url.includes("after=") ? null : connectionId,
    };
  }
  return body;
};
type FailedList = "tokens" | "connections" | "neither";
const testClient = (
  failed: FailedList,
  requests: string[],
  userId: string
): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (effect) =>
      Effect.map(effect, (request) => {
        requests.push(`${request.method} ${request.url}`);
        const tokens = request.url.includes("/pats");
        const unavailable = failed === (tokens ? "tokens" : "connections");
        let body = responseBody(request.url, request.method, userId);
        if (unavailable) {
          body = tokens
            ? { error: { code: "unauthenticated", message: "Inicia sesión" }, next: [] }
            : { error: "unauthenticated" };
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status: unavailable ? unauthorizedStatus : successStatus,
            headers: { "content-type": "application/json" },
          })
        );
      }),
    Effect.succeed
  );
const mount = (
  failed: FailedList,
  resumedUser: Option.Option<string> = Option.none()
): ReadonlyArray<string> => {
  const requests: string[] = [];
  const options = {
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      testClient(
        failed,
        requests,
        Option.getOrElse(resumedUser, () => "10000000-0000-4000-8000-000000000001")
      )
    ),
  };
  const context = { apiClient: makeFidyClient(options), webAuthClient: makeWebAuthClient(options) };
  const root = createRootRouteWithContext<typeof context>()();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/settings/access",
    component: AccessManagementPage,
  });
  const router = createRouter({
    context,
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [
        Option.isSome(resumedUser) ? "/settings/access?resume=pat" : "/settings/access",
      ],
    }),
  });
  render(
    <StrictMode>
      <SessionRegistryProvider>
        <RouterProvider router={router} />
      </SessionRegistryProvider>
    </StrictMode>
  );
  return requests;
};
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

const wait = <A,>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
it("keeps the token draft and token authority intact while paging and revoking MCP connections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = mount("neither");
      expect(yield* wait(screen.findByText("Mi token"))).toBeVisible();
      expect(yield* wait(screen.findByText("Mi conexión MCP"))).toBeVisible();
      expect(screen.getByRole("heading", { level: 1, name: "Accesos" })).toBeVisible();
      fireEvent.change(screen.getByLabelText("Nombre"), {
        target: { value: "Borrador sin guardar" },
      });
      fireEvent.click(screen.getByRole("checkbox", { name: /Lectura:/ }));
      fireEvent.click(screen.getByRole("button", { name: "Siguiente página" }));
      yield* wait(screen.findByRole("link", { name: "Primera página" }));
      expect(screen.getByLabelText("Nombre")).toHaveValue("Borrador sin guardar");
      expect(screen.getByRole("checkbox", { name: /Lectura:/ })).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Revocar este agente" }));
      expect(yield* wait(screen.findByRole("status"))).toHaveTextContent("Acceso revocado.");
      expect(requests.find((request) => request.startsWith("POST"))).toContain("/web/oauth/revoke");
      expect(
        requests.some((request) => request.startsWith("POST") && request.includes("/pats"))
      ).toBe(false);
      expect(screen.getByLabelText("Nombre")).toHaveValue("Borrador sin guardar");
    })
  ));

it.each(["tokens", "connections"] as const)(
  "keeps the other access list and creation form available when %s cannot load",
  (failed) =>
    Effect.runPromise(
      Effect.gen(function* () {
        mount(failed);
        expect(
          yield* wait(screen.findByText(failed === "tokens" ? "Mi conexión MCP" : "Mi token"))
        ).toBeVisible();
        expect(yield* wait(screen.findByRole("alert"))).toBeVisible();
        expect(screen.getByLabelText("Nombre")).toBeVisible();
        expect(screen.getByRole("button", { name: "Crear token" })).toBeDisabled();
      })
    )
);

for (const sameUser of [true, false]) {
  it(`restores the draft only for the matching authenticated User (same=${sameUser})`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const userId = "10000000-0000-4000-8000-000000000001";
        window.sessionStorage.setItem(
          "fidy:pat-identity-confirmation",
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            version: 1,
            userId,
            expiresAt:
              (yield* Clock.currentTimeMillis) +
              Duration.toMillis(Duration.minutes(handoffMinutes)),
            draft: {
              recipientLabel: "Preserved grant",
              scopes: ["read"],
              lifetimeDays: testLifetimeDays,
            },
          })
        );
        const requests = mount(
          "neither",
          Option.some(sameUser ? userId : "10000000-0000-4000-8000-000000000002")
        );
        if (sameUser) {
          expect(
            yield* wait(screen.findByRole("region", { name: "Revisión del token" }))
          ).toBeVisible();
          expect(screen.getByText("Preserved grant", { exact: true })).toBeVisible();
          expect(screen.getByText("7 días", { selector: "dd" })).toBeVisible();
          fireEvent.click(screen.getByRole("button", { name: "Siguiente página" }));
          yield* wait(screen.findByRole("link", { name: "Primera página" }));
          expect(screen.getByRole("region", { name: "Revisión del token" })).toBeVisible();
          expect(screen.getByText("Preserved grant", { exact: true })).toBeVisible();
          fireEvent.click(screen.getByRole("link", { name: "Primera página" }));
          yield* wait(screen.findByRole("button", { name: "Siguiente página" }));
          expect(screen.getByRole("region", { name: "Revisión del token" })).toBeVisible();
        } else {
          expect(yield* wait(screen.findByLabelText("Nombre"))).toHaveValue("");
          expect(
            screen.queryByRole("region", { name: "Revisión del token" })
          ).not.toBeInTheDocument();
        }
        expect(
          requests.some((request) => request.startsWith("POST") && request.includes("/pats"))
        ).toBe(false);
        expect(window.sessionStorage.length).toBe(0);
      })
    ));
}
