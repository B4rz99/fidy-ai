import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { type Cause, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { IssuedPAT, makeFidyClient } from "@/transport/client";
import { mountPATManagement } from "./management-program";

const bearer = "fin_created1_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const metadata = {
  shortId: "created1",
  recipientLabel: "Automatización casa",
  scopes: ["read", "dashboard"],
  createdAt: "2026-08-10T12:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2026-11-08T12:00:00.000Z",
};
const issued = {
  pat: {
    ...metadata,
    _tag: "PAT",
    id: "f1d1a000-0000-4000-8000-000000000248",
    lifetimeDays: 90,
    revokedAt: null,
    idleExpiresAt: metadata.expiresAt,
  },
  bearer,
};
const decodeBody = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const requestBody = Schema.Struct({
  requestId: Schema.String,
  grant: Schema.Struct({
    recipientLabel: Schema.String,
    scopes: Schema.Array(Schema.String),
    lifetimeDays: Schema.Finite,
  }),
});
const renderPATs = (
  respond: (url: string, method: string, body: unknown) => Response
): ReturnType<typeof renderFoldkit> => {
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            respond(
              request.url,
              request.method,
              request.body._tag === "Uint8Array"
                ? decodeBody(new TextDecoder().decode(request.body.body))
                : undefined
            )
          )
        )
      )
    ),
  });
  const registry = AtomRegistry.make();
  return renderFoldkit((container) => {
    const dispose = mountPATManagement({
      container,
      client,
      registry,
      resources: registry.get(client.runtime.layer),
    });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};
const click = (name: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const button = yield* Effect.tryPromise(() => screen.findByRole("button", { name }));
    yield* Effect.tryPromise(() => waitFor(() => expect(button).not.toBeDisabled()));
    fireEvent.click(button);
  });
const reviewGrant = (): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const name = yield* Effect.tryPromise(() => screen.findByLabelText("Nombre"));
    fireEvent.input(name, { target: { value: "  Automatización casa  " } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Lectura/iu }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Tablero/iu }));
    yield* click("Crear token");
    yield* Effect.tryPromise(() =>
      screen.findByRole("button", { name: "Confirmar y crear token" })
    );
  });
afterEach(() => {
  cleanupFoldkit();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reviews the exact grant, reveals only after confirmation, copies by gesture and refreshes metadata", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(IssuedPAT)(issued);
      const requests: unknown[] = [];
      let copied = "";
      vi.stubGlobal("navigator", {
        clipboard: {
          writeText: (value: string) => {
            copied = value;
            return Promise.resolve();
          },
          readText: () => Promise.resolve(copied),
        },
      });
      renderPATs((url, method, body) => {
        if (method === "GET") {
          return Response.json({
            data: { pats: requests.length === 0 ? [] : [metadata] },
            next: [],
          });
        }
        requests.push(body);
        return Response.json({ data: issued, next: [] });
      });
      yield* reviewGrant();
      expect(requests).toHaveLength(0);
      expect(screen.getByText("90 días", { selector: "dd" })).toBeVisible();
      yield* click("Confirmar y crear token");
      expect(yield* Effect.tryPromise(() => screen.findByText(bearer))).toBeVisible();
      const request = yield* Schema.decodeUnknownEffect(requestBody)(requests[0]);
      expect(request.grant).toEqual({
        recipientLabel: "Automatización casa",
        scopes: ["read", "dashboard"],
        lifetimeDays: 90,
      });
      expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u);
      yield* click("Copiar token");
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Copiado" }));
      expect(copied).toBe(bearer);
      yield* Effect.tryPromise(() => screen.findByText(metadata.shortId));
      yield* click("Crear otro token");
      yield* Effect.tryPromise(() => screen.findByLabelText("Nombre"));
      expect(screen.queryByText(bearer)).not.toBeInTheDocument();
      vi.unstubAllGlobals();
    })
  ));
it("preserves a reviewed request identity through uncertain issuance and duplicate clicks", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests: unknown[] = [];
      renderPATs((_url, method, body) => {
        if (method === "GET") return Response.json({ data: { pats: [] }, next: [] });
        requests.push(body);
        return new Response("unavailable", { status: 503 });
      });
      yield* reviewGrant();
      const submit = screen.getByRole("button", { name: "Confirmar y crear token" });
      fireEvent.click(submit);
      fireEvent.click(submit);
      yield* click("Volver a la revisión");
      expect(requests).toHaveLength(1);
      yield* click("Confirmar y crear token");
      yield* Effect.tryPromise(() => screen.findByText("No pudimos crear el token"));
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
    })
  ));
it("retains selected lifetime through editing and validates the name and scope set", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderPATs(() => Response.json({ data: { pats: [] }, next: [] }));
      const name = yield* Effect.tryPromise(() => screen.findByLabelText("Nombre"));
      expect(screen.getByRole("button", { name: "Crear token" })).toBeDisabled();
      fireEvent.input(name, { target: { value: "x".repeat(81) } });
      fireEvent.click(screen.getByRole("checkbox", { name: /Lectura/iu }));
      fireEvent.change(screen.getByLabelText("Duración del token"), { target: { value: "30" } });
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "7 días",
        "30 días",
        "90 días",
        "365 días",
      ]);
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(screen.getByRole("button", { name: "Crear token" })).toBeDisabled())
      );
      fireEvent.input(name, { target: { value: "Robot" } });
      yield* click("Crear token");
      yield* Effect.tryPromise(() => screen.findByText("30 días", { selector: "dd" }));
      yield* click("Editar");
      expect(yield* Effect.tryPromise(() => screen.findByLabelText("Nombre"))).toHaveValue("Robot");
      expect(screen.getByLabelText("Duración del token")).toHaveValue("30");
    })
  ));
it.each(["pagehide", "unmount"])("synchronously erases a disclosed bearer on %s", (event) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mounted = renderPATs((_url, method) =>
        Response.json({ data: method === "GET" ? { pats: [] } : issued, next: [] })
      );
      yield* reviewGrant();
      yield* click("Confirmar y crear token");
      const code = yield* Effect.tryPromise(() => screen.findByText(bearer));
      if (event === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else mounted.unmount();
      expect(code.textContent).toBe("");
    })
  )
);
it("requires confirmation for one and all revocation and refreshes canonical metadata", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mutations: string[] = [];
      renderPATs((url, method) => {
        if (method === "GET") {
          return Response.json({
            data: { pats: mutations.length === 0 ? [metadata] : [] },
            next: [],
          });
        }
        mutations.push(url);
        return Response.json({
          data: url.endsWith("/pats") ? { revokedCount: 0 } : { shortId: metadata.shortId },
          next: [],
        });
      });
      yield* click("Desactivar");
      expect(mutations).toHaveLength(0);
      yield* click("Sí, desactivar");
      yield* Effect.tryPromise(() => screen.findByText("No tienes tokens activos."));
      expect(mutations).toHaveLength(1);
      yield* click("Desactivar todos los tokens");
      expect(mutations).toHaveLength(1);
      yield* click("Cancelar");
      expect(mutations).toHaveLength(1);
      yield* click("Desactivar todos los tokens");
      yield* click("Sí, desactivar todos");
      yield* Effect.tryPromise(() => screen.findByText("Se desactivaron 0 tokens activos."));
      expect(mutations).toHaveLength(2);
    })
  ));
it("disables revocation after uncertain submission until a successful refresh", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let failReads = false;
      renderPATs((_url, method) =>
        method === "GET" && !failReads
          ? Response.json({ data: { pats: [metadata] }, next: [] })
          : new Response("unavailable", { status: 503 })
      );
      yield* click("Desactivar");
      yield* click("Sí, desactivar");
      yield* Effect.tryPromise(() => screen.findByText(/No pudimos confirmar la desactivación/u));
      expect(screen.getByRole("button", { name: "Sí, desactivar" })).toBeDisabled();
      failReads = true;
      yield* click("Actualizar tokens");
      yield* Effect.tryPromise(() => screen.findByText(/No pudimos actualizar tus tokens/u));
      expect(screen.getByText(metadata.recipientLabel)).toBeVisible();
      expect(screen.getByRole("button", { name: "Desactivar" })).toBeDisabled();
      failReads = false;
      yield* click("Actualizar tokens");
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(screen.getByRole("button", { name: "Desactivar" })).not.toBeDisabled())
      );
    })
  ));
