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
import { EmailReplacementFeature } from "./feature";

afterEach(cleanup);
const outcomes = [
  "request-transport",
  "complete-transport",
  "complete-malformed",
  "complete-invalid",
  "complete-fresh",
  "request-stale",
] as const;
type Outcome = (typeof outcomes)[number];

const responseFor = (outcome: Outcome): Response => {
  if (outcome === "complete-invalid") {
    return Response.json(
      {
        error: {
          code: "verification_invalid",
          message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
        },
      },
      { status: 400 }
    );
  }
  if (outcome === "complete-fresh") {
    return Response.json(
      {
        error: {
          code: "fresh_pairing_required",
          message: "Vincula el navegador de nuevo antes de cambiar tu correo.",
        },
      },
      { status: 401 }
    );
  }
  if (outcome === "request-stale") {
    return Response.json(
      { error: { code: "unauthenticated", message: "Sign in first." }, next: [] },
      { status: 401 }
    );
  }
  return Response.json({ data: { status: "wrong" }, next: [] });
};

const replacementClient = (failure: Outcome): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    if (
      !request.url.endsWith("/web/email/replacement/verify") &&
      failure !== "request-transport" &&
      failure !== "request-stale"
    ) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ data: { status: "pending" }, next: [] })
        )
      );
    }
    if (failure === "request-transport" || failure === "complete-transport") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        })
      );
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, responseFor(failure)));
  });

const renderReplacement = (failure: Outcome): void => {
  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, replacementClient(failure)),
  };
  const context = {
    apiClient: makeFidyClient(options),
    hostedTurnClient: makeHostedTurnClient(options),
    webAuthClient: makeWebAuthClient(options),
  };
  const root = createRootRouteWithContext<typeof context>()();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/settings/email",
    component: EmailReplacementFeature,
  });
  const router = createRouter({
    context,
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/settings/email"] }),
  });
  render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  );
};

const outcomeMessage = (failure: Outcome): string => {
  if (failure === "complete-invalid") return "El código no es válido";
  if (failure === "complete-fresh" || failure === "request-stale") {
    return "Vincula el navegador de nuevo";
  }
  return "No pudimos confirmar el cambio de correo";
};

it.each(outcomes)(
  "distinguishes %s replacement outcomes using only declared credential refusals",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        renderReplacement(failure);
        fireEvent.change(yield* Effect.tryPromise(() => screen.findByLabelText("Nuevo correo")), {
          target: { value: "new.mailbox@example.com" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
        if (failure !== "request-transport" && failure !== "request-stale") {
          fireEvent.change(
            yield* Effect.tryPromise(() => screen.findByLabelText("Código de verificación")),
            { target: { value: "ABCD-2345-F7KM-9Q2D-X4PT-6RWC" } }
          );
          fireEvent.click(screen.getByRole("button", { name: "Cambiar correo" }));
        }
        expect(
          yield* Effect.tryPromise(() => screen.findByText(outcomeMessage(failure)))
        ).toBeVisible();
        if (failure !== "complete-invalid") {
          expect(screen.queryByText("El código no es válido")).not.toBeInTheDocument();
        }
        if (failure !== "complete-fresh" && failure !== "request-stale") {
          expect(screen.queryByText("Vincula el navegador de nuevo")).not.toBeInTheDocument();
        }
        expect(screen.queryByDisplayValue("ABCD-2345-F7KM-9Q2D-X4PT-6RWC")).not.toBeInTheDocument();
      })
    )
);
