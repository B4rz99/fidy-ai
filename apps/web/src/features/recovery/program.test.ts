import { type Cause, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vitest";
import {
  type SensitiveClipboardSpy,
  makeSensitiveClipboardSpy,
} from "@/testing/sensitive-clipboard";
import { makeFidyClient } from "@/transport/client";
import { mountBackupRecovery } from "./program";

const code = "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});
const mount = (
  response: Response,
  copySucceeded = true
): Readonly<{
  container: HTMLElement;
  clipboard: SensitiveClipboardSpy;
  dispose: () => void;
  requests: ReturnType<typeof vi.fn<() => void>>;
}> => {
  const requests = vi.fn<() => void>();
  const apiClient = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests();
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      })
    ),
  });
  const registry = AtomRegistry.make();
  const container = document.createElement("div");
  const target = document.createElement("div");
  target.id = "backup-recovery";
  container.append(target);
  document.body.append(container);
  const clipboard = makeSensitiveClipboardSpy(copySucceeded);
  const dispose = mountBackupRecovery({
    container: target,
    apiClient,
    resources: registry.get(apiClient.runtime.layer),
    clipboard: Option.some(clipboard),
  });
  cleanups.push(() => {
    dispose();
    registry.dispose();
    container.remove();
  });
  return { container, clipboard, dispose, requests };
};
const click = (container: HTMLElement, text: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      expect
        .poll(() =>
          [...container.querySelectorAll("button")].find((button) => button.textContent === text)
        )
        .toBeDefined()
    );
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === text
    );
    button?.click();
  });

it("discloses once in scoped DOM, clears on disposal, and starts a fresh mount empty", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mounted = mount(
        Response.json({
          data: {
            status: "rotated",
            backupRecoveryCode: code,
            rotatedAt: "2026-10-11T00:00:00.000Z",
          },
          next: [],
        })
      );
      yield* click(mounted.container, "Crear un código nuevo");
      yield* Effect.tryPromise(() =>
        expect.poll(() => mounted.container.querySelector("code")?.textContent).toBe(code)
      );
      expect(mounted.container).toHaveTextContent("Guárdalo ahora");
      expect(window.location.href).not.toContain(code);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(window.history.state)
      ).not.toContain(code);
      for (const storage of [localStorage, sessionStorage]) {
        expect(
          yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String)))
          )(
            Array.from({ length: storage.length }, (_, index) =>
              storage.getItem(storage.key(index) ?? "")
            )
          )
        ).not.toContain(code);
      }
      yield* click(mounted.container, "Copiar código");
      expect(mounted.clipboard.copy).toHaveBeenCalledWith(code, expect.any(Function));
      yield* Effect.tryPromise(() =>
        expect.poll(() => mounted.container.textContent).toContain("Copiado")
      );
      mounted.dispose();
      expect(mounted.container.textContent).not.toContain(code);
      expect(mounted.clipboard.clear).toHaveBeenCalledWith(code);
      const fresh = mount(
        Response.json({
          data: {
            status: "rotated",
            backupRecoveryCode: code,
            rotatedAt: "2026-10-11T00:00:00.000Z",
          },
          next: [],
        })
      );
      yield* Effect.tryPromise(() =>
        expect.poll(() => fresh.container.textContent).toContain("Crear un código nuevo")
      );
      expect(fresh.container.textContent).not.toContain(code);
      expect(mounted.requests).toHaveBeenCalledTimes(1);
      expect(fresh.requests).not.toHaveBeenCalled();
    })
  ));

it("does not claim clipboard success after a denied write", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mounted = mount(
        Response.json({
          data: {
            status: "rotated",
            backupRecoveryCode: code,
            rotatedAt: "2026-10-11T00:00:00.000Z",
          },
          next: [],
        }),
        false
      );
      yield* click(mounted.container, "Crear un código nuevo");
      yield* click(mounted.container, "Copiar código");
      expect(mounted.clipboard.copy).toHaveBeenCalledWith(code, expect.any(Function));
      expect(mounted.container).toHaveTextContent("Copiar código");
    })
  ));

it("requires fresh sign-in when the canonical operation refuses an old session", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mounted = mount(
        Response.json(
          { error: { code: "user_action_required", message: "Fresh session required" }, next: [] },
          { status: 403 }
        )
      );
      yield* click(mounted.container, "Crear un código nuevo");
      yield* Effect.tryPromise(() =>
        expect.poll(() => mounted.container.textContent).toContain("Inicia sesión de nuevo")
      );
      expect(mounted.container.querySelector("a")?.getAttribute("href")).toBe("/auth/google");
      expect(mounted.container.querySelector("code")).toBeNull();
    })
  ));

it("keeps failure truthful and never automatically repeats a rotation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mounted = mount(
        Response.json(
          { error: { code: "unavailable", message: "Unavailable" }, next: [] },
          { status: 503 }
        )
      );
      yield* click(mounted.container, "Crear un código nuevo");
      yield* Effect.tryPromise(() =>
        expect
          .poll(() => mounted.container.textContent)
          .toContain("No pudimos confirmar el código nuevo.")
      );
      expect(mounted.container.querySelector("code")).toBeNull();
      expect(mounted.requests).toHaveBeenCalledTimes(1);
    })
  ));
