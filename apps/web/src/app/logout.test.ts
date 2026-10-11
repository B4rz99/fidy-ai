import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { it } from "@effect/vitest";
import { type Cause, Deferred, Effect, Layer } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { afterEach, expect } from "vitest";
import { mountWebApplication } from "./native-program";
import { makeAuthenticationLifetime } from "@/session/lifetime";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { type WebAuthClient, makeFidyClient, makeWebAuthClient } from "@/transport/client";

const renderShell = (webAuthClient: WebAuthClient): Array<number> => {
  const disposed: Array<number> = [];
  const options = {
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.never)
    ),
  };
  history.replaceState({}, "", "/app/dashboard");
  renderFoldkit((container): (() => void) =>
    mountWebApplication({
      container,
      createLifetime: (onExpired) => {
        const lifetime = makeAuthenticationLifetime({ apiOrigin: options.apiOrigin, onExpired });
        return {
          ...lifetime,
          apiClient: makeFidyClient(options),
          webAuthClient,
          dispose: () => {
            disposed.push(1);
            lifetime.dispose();
          },
        };
      },
    })
  );
  return disposed;
};

const wait = (assertion: () => void): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => waitFor(assertion));
const clientFor = (
  respond: (
    request: Parameters<typeof HttpClientResponse.fromWeb>[0]
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>
): WebAuthClient =>
  makeWebAuthClient({
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.makeWith<
        HttpClientError.HttpClientError,
        never,
        HttpClientError.HttpClientError,
        never
      >((effect) => Effect.flatMap(effect, respond), Effect.succeed)
    ),
  });

afterEach(cleanupFoldkit);

const unavailableStatus = 503;
const temporaryRedirectStatus = 307;

it.effect.each([unavailableStatus, temporaryRedirectStatus])(
  "observes failed logout status %s, retains local authentication and permits an explicit retry",
  (status) =>
    Effect.gen(function* () {
      let calls = 0;
      let response = new Response(null, {
        status,
        headers:
          status === temporaryRedirectStatus ? { location: "https://other.example/logout" } : {},
      });
      const disposed = renderShell(
        clientFor((request) => {
          calls += 1;
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        })
      );
      yield* wait(() =>
        expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument()
      );
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      yield* wait(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "No pudimos confirmar el cierre de sesión"
        )
      );
      expect(disposed).toEqual([]);
      expect(location.pathname).toBe("/app/dashboard");
      expect(calls).toBe(1);
      response = new Response(null, { status: 204 });
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      yield* wait(() =>
        expect(
          screen.getByRole("button", { name: "Iniciar sesión en el navegador" })
        ).toBeInTheDocument()
      );
      expect(location.pathname).toBe("/auth/pair");
      expect(disposed).toHaveLength(1);
      expect(calls).toBe(2);
    })
);

it.effect(
  "disables overlapping logout while transport is pending and publishes success only afterwards",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const disposed = renderShell(
        clientFor((request) => {
          calls += 1;
          return Deferred.await(release).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
          );
        })
      );
      yield* wait(() =>
        expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument()
      );
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      yield* wait(() =>
        expect(screen.getByRole("button", { name: "Cerrando sesión…" })).toBeDisabled()
      );
      fireEvent.click(screen.getByRole("button", { name: "Cerrando sesión…" }));
      expect(calls).toBe(1);
      expect(disposed).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* wait(() =>
        expect(
          screen.getByRole("button", { name: "Iniciar sesión en el navegador" })
        ).toBeInTheDocument()
      );
      expect(location.pathname).toBe("/auth/pair");
      expect(disposed).toHaveLength(1);
    })
);
