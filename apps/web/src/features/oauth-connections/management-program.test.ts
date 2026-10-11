import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { OAuthConnectionId, makeWebAuthClient } from "@/transport/client";
import { mountOAuthListing, mountOAuthManagement } from "./management-program";

afterEach(cleanupFoldkit);
const first = "10000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000001";
const metadata = (connectionId: string, state: string): unknown => ({
  connectionId,
  claimedClientName: "<img src=x onerror=alert(1)>",
  scopes: ["read"],
  permissions: [{ scope: "read", label: "Consultar", description: "Consultar datos" }],
  expiresAt: "2026-12-01T00:00:00Z",
  state,
  recentActivity: [
    {
      id: connectionId,
      operation: "categories.listCategories",
      outcome: "succeeded",
      occurredAt: "2026-10-03T12:00:00Z",
    },
  ],
});
const mountListing = (
  respond: (request: Readonly<{ url: string; body: unknown }>) => Response,
  accessAfter?: string
): ReturnType<typeof renderFoldkit> => {
  const client = makeWebAuthClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request)))
      )
    ),
  });
  const registry = AtomRegistry.make();
  return renderFoldkit((container): (() => void) => {
    const mount = accessAfter === undefined ? mountOAuthManagement : mountOAuthListing;
    const dispose = mount({
      container,
      client,
      resources: registry.get(client.runtime.layer),
      after:
        accessAfter === undefined
          ? Option.none()
          : Option.some(Schema.decodeSync(OAuthConnectionId)(accessAfter)),
    });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};
it.each([undefined, first])(
  "keeps claimed names as text and requires refresh after an uncertain revocation (%s)",
  (accessAfter) =>
    Effect.runPromise(
      Effect.gen(function* () {
        let revocations = 0;
        const { container } = mountListing((request) => {
          if (request.url.endsWith("/revoke")) {
            revocations += 1;
            return Response.json({ error: { code: "unavailable" } }, { status: 503 });
          }
          return Response.json({
            connections: [metadata(first, "active"), metadata(second, "active")],
            nextCursor: second,
          });
        }, accessAfter);
        expect(
          yield* Effect.tryPromise(() => screen.findAllByText("<img src=x onerror=alert(1)>"))
        ).toHaveLength(2);
        expect(container.querySelector("img")).toBeNull();
        const buttons = screen.getAllByRole("button", { name: "Revocar este agente" });
        fireEvent.click(buttons[1] ?? screen.getByText("missing"));
        expect(
          yield* Effect.tryPromise(() => screen.findByText(/No pudimos confirmar la revocación/u))
        ).toBeVisible();
        for (const button of screen.getAllByRole("button", { name: "Revocar este agente" })) {
          expect(button).toBeDisabled();
        }
        expect(revocations).toBe(1);
        expect(screen.getByText("Siguiente página")).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
        yield* Effect.tryPromise(() =>
          waitFor(() =>
            expect(
              screen.getAllByRole("button", { name: "Revocar este agente" })[0]
            ).not.toBeDisabled()
          )
        );
      })
    )
);
it.each(["expired", "revoked"])(
  "preserves state and pagination without activity details for %s connections",
  (state) =>
    Effect.runPromise(
      Effect.gen(function* () {
        mountListing(() =>
          Response.json({ connections: [metadata(first, state)], nextCursor: second })
        );
        expect(
          yield* Effect.tryPromise(() => screen.findByRole("table", { name: "Conexiones MCP" }))
        ).toBeVisible();
        expect(screen.queryByText("categories.listCategories")).not.toBeInTheDocument();
        expect(screen.queryByText(first)).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Revocar este agente" })
        ).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Siguiente página" })).toHaveAttribute(
          "href",
          `/settings/agents?after=${second}`
        );
        expect(screen.getByText(/necesitas una nueva aprobación/u)).toBeVisible();
      })
    )
);
it("retains the last listing but disables revocation when refresh fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      mountListing(() => {
        reads += 1;
        return reads === 1
          ? Response.json({ connections: [metadata(first, "active")], nextCursor: null })
          : new Response("private server failure", { status: 503 });
      });
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Revocar este agente" }));
      fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
      expect(
        yield* Effect.tryPromise(() => screen.findByText(/No pudimos actualizar la lista/u))
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Revocar este agente" })).toBeDisabled();
      expect(screen.queryByText("private server failure")).not.toBeInTheDocument();
    })
  ));

it("keeps Access continuation links in Accesos and exposes refresh only after failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      mountListing(() => {
        reads += 1;
        return reads === 1
          ? new Response("private failure", { status: 503 })
          : Response.json({ connections: [metadata(first, "active")], nextCursor: second });
      }, first);
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Actualizar lista" }));
      expect(screen.getByRole("link", { name: "Primera página" })).toHaveAttribute(
        "href",
        "/settings/access"
      );
      fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
      yield* Effect.tryPromise(() => screen.findByRole("table", { name: "Conexiones MCP" }));
      expect(screen.queryByRole("button", { name: "Actualizar lista" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Siguiente página" })).toHaveAttribute(
        "href",
        `/settings/access?after=${second}`
      );
    })
  ));

it("refreshes Accesos after revoking all canonical connections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let revoked = false;
      mountListing((request) => {
        if (request.url.endsWith("/revoke-all")) {
          revoked = true;
          return Response.json({ revoked: true });
        }
        return Response.json({
          connections: [metadata(first, revoked ? "revoked" : "active")],
          nextCursor: null,
        });
      }, first);
      const action = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Revocar todos los agentes conectados" })
      );
      fireEvent.click(action);
      yield* Effect.tryPromise(() => screen.findByText(/Acceso revocado/u));
      expect(revoked).toBe(true);
      expect(screen.queryByRole("button", { name: "Revocar este agente" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Actualizar lista" })).not.toBeInTheDocument();
    })
  ));
