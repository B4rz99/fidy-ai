import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { makeWebAuthClient } from "@/transport/client";
import { mountOAuthManagement } from "./management-program";

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
  respond: (request: Readonly<{ url: string; body: unknown }>) => Response
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
    const dispose = mountOAuthManagement({
      container,
      client,
      resources: registry.get(client.runtime.layer),
      after: Option.none(),
    });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};
it("keeps claimed names as text and requires refresh after an uncertain revocation", () =>
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
          nextCursor: null,
        });
      });
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
      fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(
            screen.getAllByRole("button", { name: "Revocar este agente" })[0]
          ).not.toBeDisabled()
        )
      );
    })
  ));
it.each(["expired", "revoked"])("preserves activity and pagination for %s connections", (state) =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountListing(() =>
        Response.json({ connections: [metadata(first, state)], nextCursor: second })
      );
      expect(
        yield* Effect.tryPromise(() => screen.findByText("categories.listCategories"))
      ).toBeVisible();
      expect(screen.getByText(/Completada/u)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Revocar este agente" })).not.toBeInTheDocument();
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
