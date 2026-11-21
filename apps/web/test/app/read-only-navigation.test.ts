import { RegistryContext } from "@effect/atom-react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { type BrowserAuthentication, SessionContext } from "@/session/session-context";
import { makeFidyClient, makeWebAuthClient } from "@/transport/client";
import { makeHostedTurnClient } from "@/transport/hosted-turn-client";
import { createWebRouter } from "@/app/routes";

const reactWork = (work: () => void): Promise<void> => Promise.resolve(act(work));

type RefusedPage = Readonly<{
  router: ReturnType<typeof createWebRouter>;
  container: HTMLDivElement;
  render: () => Promise<void>;
  dispose: () => Promise<void>;
}>;

const refusedPage = (
  authentication: BrowserAuthentication,
  path: string,
  consent: "Revoked" | "Unavailable" | "Granted" | "Missing" = "Unavailable"
): RefusedPage => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 901px)",
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }));

  const http = HttpClient.make((request) => {
    const pathname = new URL(request.url).pathname;

    if (pathname === "/web/consent" && consent === "Revoked") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            status: "Revoked",
            withdrawal: {
              reference: "30000000-0000-4000-8000-000000000001",
              occurredAtMs: 1794920000000,
            },
          })
        )
      );
    }

    if (pathname === "/web/consent" && consent !== "Unavailable") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ status: consent, withdrawal: null }))
      );
    }

    if (pathname === "/web/privacy/transactions") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            reference: "40000000-0000-4000-8000-000000000001",
            scope: "transactions",
            data: [],
            presentation: { locale: "es-CO", timeZone: "America/Bogota" },
            categories: [],
            next: null,
          })
        )
      );
    }

    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })));
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
    sessionBinding: authentication === "signed-in" ? "refused-page-session" : "none",
    registry,
    history: Option.some(createMemoryHistory({ initialEntries: [path] })),
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  return {
    router,
    container,
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
                    authentication,
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

it.each(["Unavailable", "Granted", "Missing"] as const)(
  "a refused route with %s consent offers a direct return without claiming withdrawal",
  (consent) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = refusedPage("expired", "/app/dashboard", consent);

        try {
          yield* Effect.tryPromise(page.render);
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => {
              const recovery = page.container.querySelector<HTMLAnchorElement>(
                'main a[href="/app/transactions"]'
              );

              expect(recovery?.textContent).toBe("Ver mis transacciones");
              expect(
                page.container.querySelector('main a[href="/settings/privacy"]')?.textContent
              ).toBe("Revisar privacidad");
              expect(page.container.querySelector('main a[href="/login"]')?.textContent).toBe(
                "Iniciar sesión"
              );
              expect(page.container.textContent).not.toContain(
                "Tu autorización de tratamiento está retirada"
              );
            })
          );
        } finally {
          yield* Effect.tryPromise(page.dispose);
        }
      })
    )
);

it.each(["signed-in", "expired"] as const)(
  "withdrawal keeps permitted navigation for a %s visitor and returns directly to retained Transactions",
  (authentication) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = refusedPage(authentication, "/app/recurring", "Revoked");

        try {
          yield* Effect.tryPromise(page.render);
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => {
              const navigation = page.container.querySelector('nav[aria-label="Aplicación"]');
              expect(navigation).not.toBeNull();
              expect(navigation?.textContent).toContain("Solo lectura");
              expect(navigation?.querySelector('a[href="/app/transactions"]')).not.toBeNull();
              expect(navigation?.querySelector('a[href="/settings/privacy"]')).not.toBeNull();
              expect(navigation?.querySelector('a[href="/app/recurring"]')).toBeNull();
              expect(navigation?.querySelector('a[href="/app/dashboard"]')).toBeNull();
              expect(navigation?.querySelector('a[href="/app/budgets"]')).toBeNull();
              expect(page.container.textContent).toContain(
                "Tu autorización de tratamiento está retirada"
              );
            })
          );
          yield* Effect.tryPromise(() =>
            reactWork(() =>
              page.container
                .querySelector<HTMLAnchorElement>('main a[href="/app/transactions"]')
                ?.click()
            )
          );
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => {
              expect(page.router.state.location.pathname).toBe("/app/transactions");
              expect(page.container.querySelector("h1")?.textContent).toBe("Transacciones");
              expect(page.container.textContent).toContain("Esta consulta es gratuita");
              expect(page.container.textContent).not.toContain("Nueva transacción");
            })
          );
        } finally {
          yield* Effect.tryPromise(page.dispose);
        }
      })
    )
);
