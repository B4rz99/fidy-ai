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

type MissingPage = Readonly<{
  router: ReturnType<typeof createWebRouter>;
  container: HTMLDivElement;
  render: () => Promise<void>;
  dispose: () => Promise<void>;
}>;

const missingPage = (authentication: BrowserAuthentication, path: string): MissingPage => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 901px)",
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }));

  const http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })))
  );

  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, http),
  };

  const registry = AtomRegistry.make();

  const router = createWebRouter({
    apiClient: makeFidyClient(options),
    webAuthClient: makeWebAuthClient(options),
    hostedTurnClient: makeHostedTurnClient(options),
    sessionBinding: authentication === "signed-in" ? "missing-page-session" : "none",
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

it("a missing signed-in app page keeps navigation and offers a named return to the dashboard", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const page = missingPage("signed-in", "/app/this-page-does-not-exist");

      try {
        yield* Effect.tryPromise(page.render);
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            const recovery = page.container.querySelector("main a");
            expect(recovery?.textContent).toBe("Volver al tablero");
            expect(recovery?.getAttribute("href")).toBe("/app/dashboard");
            expect(page.container.querySelector('nav[aria-label="Aplicación"]')).not.toBeNull();
          })
        );
      } finally {
        yield* Effect.tryPromise(page.dispose);
      }
    })
  ));

it.each([
  ["signed-out", "/app/this-page-does-not-exist"],
  ["signed-out", "/this-page-does-not-exist"],
  ["signed-in", "/this-page-does-not-exist"],
  ["expired", "/this-page-does-not-exist"],
] as const)(
  "a %s visitor to %s gets an explicitly named public recovery link",
  (authentication, path) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = missingPage(authentication, path);

        try {
          yield* Effect.tryPromise(page.render);
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => {
              const recovery = page.container.querySelector<HTMLAnchorElement>("main a");
              expect(recovery?.textContent).toBe("Ir al sitio web de Fidy");
              expect(recovery?.getAttribute("href")).toBe("https://fidyapp.com/");
            })
          );
        } finally {
          yield* Effect.tryPromise(page.dispose);
        }
      })
    )
);
