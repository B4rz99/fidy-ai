import { RegistryContext } from "@effect/atom-react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createWebRouter } from "@/app/routes";
import { SessionContext } from "@/session/session-context";
import { type CanonicalSuccess, makeFidyClient, makeWebAuthClient } from "@/transport/client";
import { makeHostedTurnClient } from "@/transport/hosted-turn-client";

const reactWork = (work: () => void): Promise<void> => Promise.resolve(act(work));

type ExpiredReview = Readonly<{
  container: HTMLDivElement;
  requests: string[];
  render: () => Promise<void>;
  dispose: () => Promise<void>;
}>;

const expiredReview = (
  source: CanonicalSuccess<"ingestion.getReviewWorkspace">["data"]["items"][number]["source"] = "statement",
  status: "expired" | "created" = "expired",
  originalExpired = false
): ExpiredReview => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }));
  const requests: string[] = [];

  const reviewedItem = {
    id: "24000000-0000-4000-8000-000000001794",
    source,
    status,
    reason: "ambiguous-currency",
    revision: 0,
    timeZone: "America/Bogota",
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: originalExpired ? "2099-01-02T00:00:00Z" : "2026-01-02T00:00:00Z",
    preview: { counterparty: "Expired private counterparty", amount: "1234", currency: "COP" },
  };

  const item =
    status === "created"
      ? { ...reviewedItem, transactionId: "24000000-0000-4000-8000-000000001795" }
      : reviewedItem;

  const respond = (path: string): Response => {
    if (path.endsWith("review-workspace")) {
      return Response.json({
        data: { pendingCount: 0, total: 1, items: [item], selectedDetail: { item, revision: 0 } },
        next: [],
      });
    }

    if (path.endsWith("/context")) {
      return Response.json({
        data: {
          items: [
            { id: item.id, reference: "Extracto · Fila 1", expiresAt: "2026-01-02T00:00:00Z" },
          ],
        },
        next: [],
      });
    }

    if (path.endsWith("/categories")) {
      return Response.json({ data: [], next: [] });
    }

    return new Response(null, { status: 503 });
  };

  const http = HttpClient.make((request) => {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);

    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(path)));
  });

  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, http),
  };

  const registry = AtomRegistry.make();

  const router = createWebRouter({
    apiClient: makeFidyClient(options),
    webAuthClient: makeWebAuthClient(options),
    hostedTurnClient: makeHostedTurnClient(options),
    sessionBinding: "expired-review-session",
    registry,
    history: Option.some(
      createMemoryHistory({ initialEntries: ["/app/needs-review?status=history"] })
    ),
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  return {
    container,
    requests,
    render: (): Promise<void> =>
      router.load().then(() =>
        reactWork(() =>
          root.render(
            createElement(
              StrictMode,
              null,
              createElement(
                SessionContext.Provider,
                {
                  value: Option.some({
                    authentication: "signed-in" as const,
                    completeLogin: (): void => undefined,
                    completeLogout: (): void => undefined,
                    expireAuthentication: (): void => undefined,
                    replaceAuthenticationLifetime: (): void => undefined,
                  }),
                },
                createElement(
                  RegistryContext.Provider,
                  { value: registry },
                  createElement(RouterProvider, { router })
                )
              )
            )
          )
        )
      ),
    dispose: (): Promise<void> =>
      reactWork(() => root.unmount()).then(() => {
        registry.dispose();
        container.remove();
        vi.unstubAllGlobals();
      }),
  };
};

it("helps resubmit an expired extracto through WhatsApp without disclosing expired evidence or preparing a message", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const page = expiredReview();

      try {
        yield* Effect.tryPromise(page.render);
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            const link = page.container.querySelector('a[aria-label="Abrir WhatsApp"]');
            expect(link?.getAttribute("href")).toBe("https://wa.me/12056871742");
            expect(page.container.textContent).toContain("WhatsApp que tienes vinculado");
            expect(page.container.textContent).toContain("inicias una nueva revisión");
            expect(page.container.textContent).not.toContain("Expired private counterparty");
            expect(page.container.textContent).not.toContain("Confirmar");
          })
        );
        expect(
          page.requests.some(
            (request) => request.endsWith("/material") || request.startsWith("POST ")
          )
        ).toBe(false);
      } finally {
        yield* Effect.tryPromise(page.dispose);
      }
    })
  ));

it("explains resubmission when the original expires before the history item's deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const page = expiredReview("statement", "expired", true);

      try {
        yield* Effect.tryPromise(page.render);
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            expect(page.container.textContent).toContain("inicias una nueva revisión");
            expect(page.container.querySelector('a[aria-label="Abrir WhatsApp"]')).not.toBeNull();
          })
        );
      } finally {
        yield* Effect.tryPromise(page.dispose);
      }
    })
  ));

it.each([
  ["media", "Vuelve a enviar la imagen", "https://wa.me/12056871742"],
  ["email", "El reenvío de correos a Fidy no está disponible por ahora", null],
] as const)(
  "offers the supported resubmission route for expired %s material",
  (source, instruction, destination) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = expiredReview(source);

        try {
          yield* Effect.tryPromise(page.render);
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => {
              expect(page.container.textContent).toContain(instruction);
              const link = page.container.querySelector('a[aria-label="Abrir WhatsApp"]');
              expect(link?.getAttribute("href") ?? null).toBe(destination);
              expect(page.container.textContent).toContain("Este elemento seguirá vencido");

              const text = page.container.textContent;
              expect(source !== "email" || text.includes("manualmente en Transacciones")).toBe(
                true
              );
              expect(source !== "email" || !text.includes("inicias una nueva revisión")).toBe(true);
            })
          );
        } finally {
          yield* Effect.tryPromise(page.dispose);
        }
      })
    )
);

it("keeps the created Transaction reachable after expiry without inviting a duplicate submission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const page = expiredReview("statement", "created");

      try {
        yield* Effect.tryPromise(page.render);
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            const transaction = page.container.querySelector(
              'a[href*="24000000-0000-4000-8000-000000001795"]'
            );

            expect(transaction?.textContent).toBe("Ver transacción");
            expect(page.container.querySelector('a[aria-label="Abrir WhatsApp"]')).toBeNull();
            expect(page.container.textContent).not.toContain("inicias una nueva revisión");
          })
        );
      } finally {
        yield* Effect.tryPromise(page.dispose);
      }
    })
  ));
