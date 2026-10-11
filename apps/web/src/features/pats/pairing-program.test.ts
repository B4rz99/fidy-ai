import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { type Cause, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { makeFidyClient } from "@/transport/client";
import { mountCLIPairing } from "./pairing-program";

afterEach(cleanupFoldkit);
const decodeBody = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const pairingId = "f1d1a000-0000-4000-8000-000000000249";
const review = {
  pairingId,
  recipientLabel: "Cliente <script>de escritorio</script>",
  scopes: ["read", "dashboard"],
  lifetimeDays: 7,
  claimBy: "2099-08-25T12:10:00.000Z",
};
const renderPairing = (
  configuration: Readonly<{ code: unknown; respond: (url: string, body: unknown) => Response }>
): (() => void) => {
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? decodeBody(new TextDecoder().decode(request.body.body))
              : undefined;
          return HttpClientResponse.fromWeb(request, configuration.respond(request.url, body));
        })
      )
    ),
  });
  const registry = AtomRegistry.make();
  return renderFoldkit((container): (() => void) => {
    const dispose = mountCLIPairing({
      container,
      client,
      resources: registry.get(client.runtime.layer),
      code: configuration.code,
    });
    return () => {
      dispose();
      registry.dispose();
    };
  }).unmount;
};
const enterCode = (value: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const input = yield* Effect.tryPromise(() => screen.findByLabelText("Código"));
    fireEvent.input(input, { target: { value } });
    yield* Effect.tryPromise(() =>
      waitFor(() => expect(screen.getByRole("button", { name: "Continuar" })).not.toBeDisabled())
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
  });
it("normalizes code, reviews unverified metadata, and approves only the inspected identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests: unknown[] = [];
      renderPairing({
        code: undefined,
        respond: (url, body) => {
          requests.push(body);
          return Response.json({
            data: url.endsWith("/inspect")
              ? review
              : { pairingId, patExpiresAt: "2099-08-26T12:10:00.000Z", claimBy: review.claimBy },
            next: [],
          });
        },
      });
      yield* enterCode("  bcdf-ghjk  ");
      expect(
        yield* Effect.tryPromise(() => screen.findByText(review.recipientLabel))
      ).toBeVisible();
      expect(screen.getByText("7 días")).toBeVisible();
      expect(document.querySelector("script")).toBeNull();
      expect(requests).toEqual([{ publicCode: "BCDF-GHJK" }]);
      fireEvent.click(screen.getByRole("button", { name: "Autorizar acceso" }));
      expect(yield* Effect.tryPromise(() => screen.findByText("Acceso autorizado"))).toBeVisible();
      expect(requests).toEqual([{ publicCode: "BCDF-GHJK" }, { pairingId }]);
      expect(screen.getByText(/Este navegador no recibe ni muestra/u)).toBeVisible();
    })
  ));
it("preselects without approving and does not repeat an uncertain approval", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let approvals = 0;
      renderPairing({
        code: "BCDF-GHJK",
        respond: (url) => {
          if (url.endsWith("/inspect")) return Response.json({ data: review, next: [] });
          approvals += 1;
          return new Response("unavailable", { status: 503 });
        },
      });
      const approve = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Autorizar acceso" })
      );
      expect(approvals).toBe(0);
      fireEvent.click(approve);
      fireEvent.click(approve);
      expect(
        yield* Effect.tryPromise(() => screen.findByText("No encontramos ese código"))
      ).toBeVisible();
      expect(approvals).toBe(1);
      expect(screen.queryByRole("link", { name: /Iniciar sesión/u })).not.toBeInTheDocument();
    })
  ));
it("never publishes or sends a secret-like invalid paste and clears the draft on disposal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let requests = 0;
      const dispose = renderPairing({
        code: undefined,
        respond: () => {
          requests += 1;
          return new Response("unavailable", { status: 503 });
        },
      });
      yield* enterCode("private-secret");
      yield* Effect.tryPromise(() => screen.findByText("No encontramos ese código"));
      expect(requests).toBe(0);
      expect(screen.queryByRole("link", { name: /Iniciar sesión/u })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Ingresar otro código" }));
      const input = yield* Effect.tryPromise(() => screen.findByLabelText("Código"));
      fireEvent.input(input, { target: { value: "unsent-private" } });
      dispose();
      expect(input).toHaveValue("");
    })
  ));
it("offers a fixed sign-in destination only for a validated public code after failed inspection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderPairing({
        code: undefined,
        respond: () => new Response("unavailable", { status: 503 }),
      });
      yield* enterCode("bcdf-ghjk");
      expect(
        yield* Effect.tryPromise(() =>
          screen.findByRole("link", { name: "Iniciar sesión para revisar la solicitud" })
        )
      ).toHaveAttribute("href", "/auth/pair?cliCode=BCDF-GHJK");
    })
  ));
