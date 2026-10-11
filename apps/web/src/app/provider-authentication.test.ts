import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { afterEach, expect, it, vi } from "vitest";
import { mountWebApplication } from "./native-program";
import { makeAuthenticationLifetime } from "@/session/lifetime";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { makeFidyClient, makeHostedTurnClient, makeWebAuthClient } from "@/transport/client";

afterEach(() => {
  cleanupFoldkit();
  vi.restoreAllMocks();
});
const renderAuthentication = (
  httpClient: HttpClient.HttpClient
): ReturnType<typeof renderFoldkit> => {
  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
  };
  history.replaceState({}, "", "/auth/google");
  return renderFoldkit((container) =>
    mountWebApplication({
      container,
      createLifetime: (onExpired) => ({
        ...makeAuthenticationLifetime({ apiOrigin: options.apiOrigin, onExpired }),
        apiClient: makeFidyClient(options),
        hostedTurnClient: makeHostedTurnClient(options),
        webAuthClient: makeWebAuthClient(options),
      }),
    })
  );
};

const authenticationLifetime = Effect.gen(function* () {
  const started = vi.fn<() => void>();
  const interrupted = vi.fn<() => void>();
  const httpClient = HttpClient.make((request) =>
    request.method === "POST"
      ? Effect.sync(started).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(interrupted))
        )
      : Effect.never
  );
  const opened = vi.spyOn(window, "open").mockReturnValue(window);
  const closed = vi.spyOn(window, "close").mockImplementation(() => {});
  const mounted = renderAuthentication(httpClient);
  fireEvent.click(
    yield* Effect.tryPromise(() =>
      screen.findByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" })
    )
  );
  yield* Effect.tryPromise(() =>
    waitFor(() => expect(screen.getByRole("heading", { name: "Inicia sesión" })).toBeVisible())
  );
  fireEvent.click(screen.getByRole("button", { name: "Continuar con Google" }));
  yield* Effect.tryPromise(() => waitFor(() => expect(started).toHaveBeenCalledTimes(1)));
  expect(opened).toHaveBeenCalledTimes(1);
  mounted.unmount();
  expect(closed).toHaveBeenCalledTimes(1);
  yield* Effect.tryPromise(() => waitFor(() => expect(interrupted).toHaveBeenCalledTimes(1)));
  renderAuthentication(httpClient);
  expect(
    yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Crea tu cuenta" }))
  ).toBeVisible();
  expect(screen.queryByText("Esperando confirmación…")).not.toBeInTheDocument();
  expect(started).toHaveBeenCalledTimes(1);
});

it("revokes pending authentication on unmount and starts a fresh lifetime on remount", () =>
  Effect.runPromise(authenticationLifetime));
