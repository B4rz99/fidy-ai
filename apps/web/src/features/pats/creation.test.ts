// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import { type SensitiveClipboard, makeSensitiveClipboard } from "@/browser/sensitive-clipboard";
import { makeFidyClient } from "@/transport/client";
import { ManualPATCreation } from "./creation";

const bearer = "fin_abcdefgh_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const reactWork = (work: () => void): Promise<void> =>
  Promise.resolve(act(() => Promise.resolve(work())));
const reactAssertion = (assertion: () => void): Promise<void> =>
  Promise.resolve(act(() => vi.waitFor(assertion)));
const button = (container: HTMLElement, label: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label
  );
  if (found === undefined) throw new Error(`Missing ${label}`);
  return found;
};
const click = (container: HTMLElement, label: string): Promise<void> =>
  reactWork(() => button(container, label).click());
const editGrant = (container: HTMLElement): Promise<void> =>
  reactWork(() => {
    const input = container.querySelector("input#pat-recipient");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!(input instanceof HTMLInputElement) || setter === undefined) {
      throw new Error("Missing recipient input");
    }
    setter.call(input, "Mi agente");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }).then(() =>
    reactWork(() => {
      const scope = container.querySelector("#pat-scope-read");
      if (!(scope instanceof HTMLElement)) throw new Error("Missing read scope");
      scope.click();
    })
  );
const makeClient = (): ReturnType<typeof makeFidyClient> => {
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          data: {
            pat: {
              _tag: "PAT",
              id: "10000000-0000-4000-8000-000000000001",
              shortId: "abcdefgh",
              recipientLabel: "Mi agente",
              scopes: ["read"],
              lifetimeDays: 90,
              createdAt: "2026-11-12T00:00:00.000Z",
              expiresAt: "2026-11-19T00:00:00.000Z",
              idleExpiresAt: "2026-11-19T00:00:00.000Z",
              lastUsedAt: null,
              revokedAt: null,
            },
            bearer,
          },
          next: [],
        })
      )
    )
  );
  return makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, http),
  });
};

for (const retirement of ["reset", "pagehide", "expiry"] as const) {
  for (const unrelated of [false, true]) {
    it.effect(
      `pending PAT copy is retired by ${retirement}; preserve unrelated content: ${unrelated}`,
      () =>
        Effect.gen(function* () {
          vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
          const pending = Promise.withResolvers<void>();
          let text = "";
          const nativeWrites = vi.fn();
          const native = yield* makeSensitiveClipboard(
            Option.some({
              readText: () => Promise.resolve(text),
              writeText: (value) => {
                nativeWrites(value);
                return value === bearer
                  ? pending.promise.then(() => {
                      text = unrelated ? "unrelated text" : value;
                    })
                  : Promise.resolve().then(() => {
                      text = value;
                    });
              },
            }),
            "10 minutes"
          );
          const released = vi.fn();
          const copied = vi.fn();
          const clipboard: SensitiveClipboard = {
            reveal: native.reveal,
            copy: (value, onCopied) => {
              const exact = native.copy(value, () => {
                copied();
                onCopied?.();
              });
              return {
                release: () => {
                  released();
                  exact.release();
                },
              };
            },
          };
          const context = yield* Effect.context<never>();
          const registry = AtomRegistry.make();
          const container = document.createElement("div");
          document.body.append(container);
          const root = createRoot(container);
          try {
            yield* Effect.tryPromise(() =>
              reactWork(() =>
                root.render(
                  createElement(
                    RegistryContext.Provider,
                    { value: registry },
                    createElement(ManualPATCreation, {
                      apiClient: makeClient(),
                      clipboard,
                      resuming: false,
                    })
                  )
                )
              )
            );
            yield* Effect.tryPromise(() => editGrant(container));
            yield* Effect.tryPromise(() => click(container, "Crear token"));
            yield* Effect.tryPromise(() => click(container, "Confirmar y crear token"));
            yield* Effect.tryPromise(() =>
              reactAssertion(() => expect(container.textContent).toContain(bearer))
            );
            yield* Effect.tryPromise(() => click(container, "Copiar token"));
            expect(nativeWrites).toHaveBeenCalledWith(bearer);
            if (retirement === "reset") {
              yield* Effect.tryPromise(() => click(container, "Crear otro token"));
            }
            if (retirement === "pagehide") {
              yield* Effect.tryPromise(() =>
                reactWork(() => window.dispatchEvent(new Event("pagehide")))
              );
            }
            if (retirement === "expiry") {
              yield* Effect.tryPromise(() =>
                Promise.resolve(
                  act(() => Effect.runPromiseWith(context)(TestClock.adjust("10 minutes")))
                )
              );
            }
            expect(container.textContent).not.toContain(bearer);
            expect(released).toHaveBeenCalledTimes(1);
            pending.resolve();
            yield* Effect.tryPromise(() => reactWork(() => undefined));
            expect(copied).not.toHaveBeenCalled();
            expect(container.textContent).not.toContain("Copiado");
            expect(text).toBe(unrelated ? "unrelated text" : "");
          } finally {
            yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
            registry.dispose();
            container.remove();
            vi.unstubAllGlobals();
          }
        })
    );
  }
}
