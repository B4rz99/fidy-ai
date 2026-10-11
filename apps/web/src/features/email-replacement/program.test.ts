import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { AtomRegistry } from "effect/reactivity";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { afterEach, expect, it } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { mountEmailReplacement } from "./program";

afterEach(cleanupFoldkit);
const outcomes = [
  "request-transport",
  "complete-transport",
  "complete-malformed",
  "complete-invalid",
  "complete-fresh",
  "request-stale",
  "complete-success",
] as const;
type Outcome = (typeof outcomes)[number];

const responseFor = (outcome: Outcome): Response => {
  if (outcome === "complete-success") {
    return Response.json({ data: { status: "replaced" }, next: [] });
  }
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

const renderClient = (client: HttpClient.HttpClient): ReturnType<typeof renderFoldkit> => {
  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, client),
  };
  const apiClient = makeFidyClient(options);
  const registry = AtomRegistry.make();
  return renderFoldkit((container): (() => void) => {
    const dispose = mountEmailReplacement({
      container,
      apiClient,
      resources: registry.get(apiClient.runtime.layer),
    });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};

const outcomeMessage = (failure: Outcome): string => {
  if (failure === "complete-success") return "Correo actualizado";
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
        renderClient(replacementClient(failure));
        fireEvent.input(yield* Effect.tryPromise(() => screen.findByLabelText("Nuevo correo")), {
          target: { value: "new.mailbox@example.com" },
        });
        yield* Effect.tryPromise(() =>
          waitFor(() =>
            expect(screen.getByRole("button", { name: "Enviar código" })).not.toBeDisabled()
          )
        );
        fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
        if (failure !== "request-transport" && failure !== "request-stale") {
          fireEvent.input(
            yield* Effect.tryPromise(() => screen.findByLabelText("Código de verificación")),
            { target: { value: "ABCD-2345-F7KM-9Q2D-X4PT-6RWC" } }
          );
          yield* Effect.tryPromise(() =>
            waitFor(() =>
              expect(screen.getByRole("button", { name: "Cambiar correo" })).not.toBeDisabled()
            )
          );
          fireEvent.click(screen.getByRole("button", { name: "Cambiar correo" }));
        }
        expect(
          yield* Effect.tryPromise(() => screen.findByText(outcomeMessage(failure)))
        ).toBeVisible();
        if (failure === "complete-invalid") {
          expect(
            yield* Effect.tryPromise(() => screen.findByText("new.mailbox@example.com"))
          ).toBeVisible();
        }
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

it("shows pending work and releases the mounted private input immediately", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mounted = renderClient(HttpClient.make(() => Effect.never));
      const input = yield* Effect.tryPromise(() => screen.findByLabelText("Nuevo correo"));
      fireEvent.input(input, { target: { value: "private@example.com" } });
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(screen.getByRole("button", { name: "Enviar código" })).not.toBeDisabled()
        )
      );
      fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
      expect(yield* Effect.tryPromise(() => screen.findByText("Procesando…"))).toBeVisible();
      expect(input).toHaveValue("");
      mounted.unmount();
    })
  ));

it("clears an unsent mailbox synchronously when its owner closes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mounted = renderClient(replacementClient("complete-success"));
      const input = yield* Effect.tryPromise(() => screen.findByLabelText("Nuevo correo"));
      fireEvent.input(input, { target: { value: "private@example.com" } });
      mounted.unmount();
      expect(input).toHaveValue("");
    })
  ));
