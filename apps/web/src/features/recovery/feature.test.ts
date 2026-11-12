// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { BackupRecoveryFeature } from "./feature";

const recoveryCode = "ABCDE-FGHJK-LMNPQ-RSTUV-WXY23";
const reactWork = (work: () => void): Promise<void> =>
  Promise.resolve(act(() => Promise.resolve(work())));
const reactAssertion = (assertion: () => void): Promise<void> =>
  Promise.resolve(act(() => vi.waitFor(assertion)));
const click = (container: HTMLElement, label: string): Promise<void> =>
  reactWork(() => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === label
    );
    if (button === undefined) throw new Error(`Missing ${label}`);
    button.click();
  });

it.each(["matching", "unrelated", "pending"] as const)(
  "pagehide disposes a copied Recovery disclosure while mounted: %s",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
        let text = "";
        const pending = Promise.withResolvers<void>();
        const clipboard = {
          readText: (): Promise<string> => Promise.resolve(text),
          writeText: (value: string): Promise<void> => {
            if (scenario === "pending" && value === recoveryCode) {
              return pending.promise.then(() => {
                text = value;
              });
            }
            text = value;
            return Promise.resolve();
          },
        };
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
        const http = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: {
                  status: "rotated",
                  backupRecoveryCode: recoveryCode,
                  rotatedAt: "2026-11-12T00:00:00.000Z",
                },
                next: [],
              })
            )
          )
        );
        const apiClient = makeFidyClient({
          apiOrigin: "https://api.test.fidyapp.com",
          httpClient: Layer.succeed(HttpClient.HttpClient, http),
        });
        const registry = AtomRegistry.make();
        const router = createRouter({
          routeTree: createRootRoute({ component: BackupRecoveryFeature }),
          context: { apiClient },
          history: createMemoryHistory(),
        });
        const container = document.createElement("div");
        const root = createRoot(container);
        try {
          yield* Effect.tryPromise(() => router.load());
          yield* Effect.tryPromise(() =>
            reactWork(() =>
              root.render(
                createElement(
                  RegistryContext.Provider,
                  { value: registry },
                  createElement(RouterProvider, { router })
                )
              )
            )
          );
          yield* Effect.tryPromise(() => click(container, "Crear un código nuevo"));
          yield* Effect.tryPromise(() => click(container, "Confirmar código nuevo"));
          yield* Effect.tryPromise(() =>
            reactAssertion(() => expect(container.textContent).toContain(recoveryCode))
          );
          yield* Effect.tryPromise(() => click(container, "Copiar código"));
          if (scenario !== "pending") expect(text).toBe(recoveryCode);
          if (scenario === "unrelated") text = "unrelated text";
          yield* Effect.tryPromise(() =>
            reactWork(() => window.dispatchEvent(new Event("pagehide")))
          );
          expect(container.textContent).not.toContain(recoveryCode);
          pending.resolve();
          yield* Effect.tryPromise(() => reactWork(() => undefined));
          expect(container.textContent).not.toContain("Copiado");
          expect(text).toBe(scenario === "unrelated" ? "unrelated text" : "");
        } finally {
          yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
          registry.dispose();
          Reflect.deleteProperty(navigator, "clipboard");
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
        }
      })
    )
);
