import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type Cause, Effect, Layer } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { afterEach, expect, it } from "vitest";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient, makeWebAuthClient } from "@/transport/client";
import { AccessManagementPage } from "./access-page";

const unauthorizedStatus = 401;
const successStatus = 200;
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
type FailedList = "tokens" | "connections" | "neither";
const testClient = (failed: FailedList, requests: string[]): HttpClient.HttpClient =>
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
        let body: unknown = { revoked: true };
        if (tokens) {
          body = { data: { pats: [pat] }, next: [] };
        } else if (request.method === "GET") {
          body = {
            connections: [connection],
            nextCursor: request.url.includes("after=") ? null : connectionId,
          };
        }
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
const mount = (failed: FailedList): ReadonlyArray<string> => {
  const requests: string[] = [];
  const options = {
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, testClient(failed, requests)),
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
    history: createMemoryHistory({ initialEntries: ["/settings/access"] }),
  });
  render(
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
  return requests;
};
afterEach(cleanup);

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
