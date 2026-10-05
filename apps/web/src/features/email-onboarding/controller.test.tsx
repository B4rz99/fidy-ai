import { RegistryProvider } from "@effect/atom-react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { afterEach, expect, it } from "vitest";
import { makeFidyClient, makeHostedTurnClient, makeWebAuthClient } from "@/transport/client";
import { EmailOnboardingFeature } from "./feature";

afterEach(cleanup);
type Outcome = "transport" | "malformed" | "invalid";

const verificationClient = (failure: Outcome): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    failure === "transport"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          })
        )
      : Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            failure === "invalid"
              ? Response.json(
                  {
                    error: {
                      code: "verification_invalid",
                      message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
                    },
                  },
                  { status: 400 }
                )
              : Response.json({ status: "created" })
          )
        )
  );

const renderOnboarding = (failure: Outcome): void => {
  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, verificationClient(failure)),
  };
  const context = {
    apiClient: makeFidyClient(options),
    hostedTurnClient: makeHostedTurnClient(options),
    webAuthClient: makeWebAuthClient(options),
  };
  const root = createRootRouteWithContext<typeof context>()();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/auth/verify-email",
    component: EmailOnboardingFeature,
  });
  const router = createRouter({
    context,
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/auth/verify-email"] }),
  });
  render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  );
};

it.each(["transport", "malformed", "invalid"] as const)(
  "distinguishes %s verification responses using only declared proof refusals",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        renderOnboarding(failure);
        fireEvent.change(
          yield* Effect.tryPromise(() => screen.findByLabelText("Código de verificación")),
          { target: { value: "ABCD-2345-F7KM-9Q2D-X4PT-6RWC" } }
        );
        fireEvent.click(screen.getByRole("button", { name: "Verificar y crear mi cuenta" }));
        expect(
          yield* Effect.tryPromise(() =>
            screen.findByText(
              failure === "invalid"
                ? "El código no es válido"
                : "No pudimos confirmar la verificación"
            )
          )
        ).toBeVisible();
        if (failure !== "invalid") {
          expect(screen.queryByText("El código no es válido")).not.toBeInTheDocument();
        }
        expect(screen.queryByDisplayValue("ABCD-2345-F7KM-9Q2D-X4PT-6RWC")).not.toBeInTheDocument();
      })
    )
);
