import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { type Cause, Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it } from "vitest";
import { OAuthConnectionId, makeWebAuthClient } from "@/transport/client";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { mountOAuthManagement } from "./management-program";
import { mountOAuthReview } from "./review-program";

const requestId = "10000000-0000-4000-8000-000000000001";
const review = {
  requestId,
  claimedClientName: "Agente personal",
  scopes: ["read"],
  permissions: [
    { scope: "read", label: "Consultar tus datos", description: "Consulta tus datos." },
  ],
  reviewedAt: "2026-10-03T12:00:00.000Z",
  requestExpiresAt: "2026-10-03T12:10:00.000Z",
  connectAvailable: true,
};
const connection = {
  connectionId: requestId,
  claimedClientName: "Agente personal",
  scopes: review.scopes,
  permissions: review.permissions,
  expiresAt: "2026-12-01T00:00:00Z",
  state: "active",
  recentActivity: [],
};
const successStatus = 200;
type Reply = Readonly<{ body: unknown }> | Readonly<{ body: unknown; status: number }>;
const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const renderFeature = (
  path: string,
  handler: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Reply>
): void => {
  const httpClient = HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (effect) =>
      Effect.flatMap(effect, (request) =>
        handler(request).pipe(
          Effect.map((reply) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(reply.body), {
                status: "status" in reply ? reply.status : successStatus,
                headers: { "content-type": "application/json" },
              })
            )
          )
        )
      ),
    Effect.succeed
  );
  const client = makeWebAuthClient({
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
  });
  const registry = AtomRegistry.make();
  const location = new URL(path, "https://app.fidyapp.com");
  renderFoldkit((container): (() => void) => {
    const resources = registry.get(client.runtime.layer);
    const dispose =
      location.pathname === "/settings/agents"
        ? mountOAuthManagement({
            container,
            client,
            resources,
            after: Option.map(
              Option.fromNullOr(location.searchParams.get("after")),
              OAuthConnectionId.make
            ),
          })
        : mountOAuthReview({
            container,
            client,
            resources,
            requestId: location.pathname.split("/").at(-1),
            redirect: () => undefined,
          });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};
afterEach(cleanupFoldkit);

it("refuses malformed review references without querying authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests: string[] = [];
      renderFeature("/oauth/invalid", (request) => {
        requests.push(request.url);
        return Effect.succeed({ body: review });
      });
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "La solicitud no es válida."
      );
      expect(requests).toEqual([]);
    })
  ));
it("keeps unavailable review separate from approval and offers fresh sign-in", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderFeature(`/oauth/${requestId}`, () =>
        Effect.succeed({ body: { error: "unauthenticated" }, status: 401 })
      );
      expect(yield* wait(screen.findByText("Solicitud no disponible"))).toBeVisible();
      expect(screen.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
        "href",
        `/auth/pair?oauthRequest=${requestId}`
      );
    })
  ));
it("cancels a reviewed request and never presents it as approved", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderFeature(`/oauth/${requestId}`, (request) =>
        Effect.succeed({ body: request.method === "GET" ? review : { cancelled: true } })
      );
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Cancelar" })));
      expect(
        yield* wait(screen.findByText("Solicitud cancelada. No se autorizó ningún acceso."))
      ).toBeVisible();
    })
  ));
it("reports cancellation failure and allows a deliberate retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let attempts = 0;
      renderFeature(`/oauth/${requestId}`, (request) => {
        if (request.method === "GET") return Effect.succeed({ body: review });
        attempts += 1;
        return Effect.succeed(
          attempts === 1
            ? { body: { error: "temporarily_unavailable" }, status: 503 }
            : { body: { cancelled: true } }
        );
      });
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Cancelar" })));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent("No pudimos cancelar.");
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      expect(
        yield* wait(screen.findByText("Solicitud cancelada. No se autorizó ningún acceso."))
      ).toBeVisible();
      expect(attempts).toBe(2);
    })
  ));
it("does not replay an uncertain approval or label it connected", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let attempts = 0;
      renderFeature(`/oauth/${requestId}`, (request) => {
        if (request.method === "GET") return Effect.succeed({ body: review });
        attempts += 1;
        return Effect.succeed({ body: { error: "temporarily_unavailable" }, status: 503 });
      });
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Conectar" })));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "no repitas esta aprobación"
      );
      yield* wait(
        waitFor(() => expect(screen.getByRole("button", { name: "Conectando…" })).toBeDisabled())
      );
      expect(attempts).toBe(1);
    })
  ));
it("keeps loading distinct from empty connection evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reply = Promise.withResolvers<Reply>();
      renderFeature("/settings/agents", () => wait(reply.promise).pipe(Effect.orDie));
      expect(yield* wait(screen.findByText("Cargando agentes…"))).toBeVisible();
      expect(screen.queryByText("No hay conexiones en esta página.")).not.toBeInTheDocument();
      reply.resolve({ body: { connections: [], nextCursor: null } });
      expect(yield* wait(screen.findByText("No hay conexiones en esta página."))).toBeVisible();
    })
  ));
it("keeps unavailable management evidence distinct from an empty list", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderFeature("/settings/agents", () =>
        Effect.succeed({ body: { error: "unauthenticated" }, status: 401 })
      );
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "no mostramos una lista vacía"
      );
      expect(screen.queryByText("No hay conexiones en esta página.")).not.toBeInTheDocument();
    })
  ));
it.each(["Revocar este agente", "Revocar todos los agentes conectados"])(
  "invalidates the owned list after %s",
  (button) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mutations: string[] = [];
        let reads = 0;
        renderFeature("/settings/agents", (request) => {
          if (request.method === "GET") {
            reads += 1;
            return Effect.succeed({ body: { connections: [connection], nextCursor: null } });
          }
          mutations.push(request.url);
          return Effect.succeed({ body: { revoked: true } });
        });
        yield* wait(screen.findByText("Agente personal"));
        fireEvent.click(screen.getByRole("button", { name: button }));
        expect(yield* wait(screen.findByRole("status"))).toHaveTextContent("Acceso revocado.");
        yield* wait(waitFor(() => expect(reads).toBeGreaterThan(1)));
        expect(mutations).toHaveLength(1);
      })
    )
);
it("does not claim successful revocation on failure and permits refreshing evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      renderFeature("/settings/agents", (request) => {
        if (request.method === "GET") {
          reads += 1;
          return Effect.succeed({ body: { connections: [connection], nextCursor: null } });
        }
        return Effect.succeed({ body: { error: "temporarily_unavailable" }, status: 503 });
      });
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Revocar este agente" })));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "No pudimos confirmar la revocación."
      );
      fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
      yield* wait(waitFor(() => expect(reads).toBeGreaterThan(1)));
    })
  ));
it("marks previous connection evidence stale and disables revocation after refresh failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      renderFeature("/settings/agents", () => {
        reads += 1;
        return Effect.succeed(
          reads === 1
            ? { body: { connections: [connection], nextCursor: null } }
            : { body: { error: "temporarily_unavailable" }, status: 503 }
        );
      });
      yield* wait(screen.findByText("Agente personal"));
      fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "La información anterior puede haber cambiado."
      );
      expect(screen.getByRole("button", { name: "Revocar este agente" })).toBeDisabled();
    })
  ));
it("offers public pagination and a first-page link", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderFeature(`/settings/agents?after=${requestId}`, () =>
        Effect.succeed({ body: { connections: [connection], nextCursor: requestId } })
      );
      expect(yield* wait(screen.findByRole("link", { name: "Siguiente página" }))).toHaveAttribute(
        "href",
        `/settings/agents?after=${requestId}`
      );
      expect(screen.getByRole("link", { name: "Primera página" })).toHaveAttribute(
        "href",
        "/settings/agents"
      );
    })
  ));

it("submits only reviewed scopes with the selected absolute expiration", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let choice: unknown;
      renderFeature(`/oauth/${requestId}`, (request) => {
        if (request.method === "GET") {
          return Effect.succeed({
            body: { ...review, claimedClientName: "<img src=x onerror=alert(1)>" },
          });
        }
        if (request.body._tag === "Uint8Array") {
          choice = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
            new TextDecoder().decode(request.body.body)
          );
        }
        return Effect.succeed({ body: { error: "temporarily_unavailable" }, status: 503 });
      });
      expect(yield* wait(screen.findByText("<img src=x onerror=alert(1)>"))).toBeVisible();
      expect(document.querySelector("img")).toBeNull();
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
      fireEvent.click(screen.getByRole("checkbox"));
      yield* wait(
        waitFor(() => expect(screen.getByRole("button", { name: "Conectar" })).toBeDisabled())
      );
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "7 días" }));
      yield* wait(
        waitFor(() =>
          expect(screen.getByRole("button", { name: "7 días" })).toHaveAttribute(
            "aria-pressed",
            "true"
          )
        )
      );
      expect(document.querySelector('time[datetime="2026-10-10T12:00:00.000Z"]')).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
      yield* wait(screen.findByText(/no repitas esta aprobación/u));
      expect(choice).toEqual({
        requestId,
        scopes: ["read"],
        lifetimeDays: 7,
        reviewedAt: review.reviewedAt,
        expiresAt: "2026-10-10T12:00:00.000Z",
      });
    })
  ));
