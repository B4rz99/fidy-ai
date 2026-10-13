import { it } from "@effect/vitest";
import { RegistryProvider } from "@effect/atom-react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type Cause, Effect, Layer, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { type JSX, StrictMode } from "react";
import { afterEach, expect, vi } from "vitest";
import {
  PATLifetimeDays,
  PATRecipientLabel,
  PATScopes,
  makeFidyClient,
  patLifetimeDayOptions,
} from "@/transport/client";
import { makeSensitiveClipboardSpy } from "@/testing/sensitive-clipboard";
import { ManualPATCreation } from "./creation";
import { preservePATDraft } from "./reauthentication-draft";

const userId = "10000000-0000-4000-8000-000000000001";
const bearer = "fin_created1_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const issued = (): Response =>
  Response.json({
    data: {
      pat: {
        _tag: "PAT",
        id: userId,
        shortId: "created1",
        recipientLabel: "Automatización casa",
        scopes: ["read", "dashboard"],
        lifetimeDays: 90,
        createdAt: "2026-10-01T14:00:00Z",
        expiresAt: "2026-12-30T14:00:00Z",
        idleExpiresAt: "2026-12-30T14:00:00Z",
        lastUsedAt: null,
        revokedAt: null,
      },
      bearer,
    },
    next: [],
  });
const needsIdentity = (): Response =>
  Response.json(
    {
      error: { code: "user_action_required", reason: "reauthentication_required", userId },
      next: [],
    },
    { status: 403 }
  );
const payloadSchema = Schema.fromJsonString(
  Schema.Struct({
    requestId: Schema.String,
    grant: Schema.Struct({
      recipientLabel: Schema.String,
      scopes: Schema.Array(Schema.String),
      lifetimeDays: Schema.Finite,
    }),
  })
);
const currentUserResponse = (): Response =>
  Response.json({
    data: {
      id: userId,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
      trialPeriod: { startedAt: "2026-10-01T14:00:00Z", endsAt: "2026-10-08T14:00:00Z" },
      createdAt: "2026-10-01T14:00:00Z",
    },
    next: [],
  });
type Mounted = ReturnType<typeof render> &
  Readonly<{
    requests: Array<typeof payloadSchema.Type>;
    clipboard: ReturnType<typeof makeSensitiveClipboardSpy>;
    replace: () => void;
  }>;
const restoreLifetime = 7;
const mount = (
  respond: () => Effect.Effect<Response> = () => Effect.sync(issued),
  resuming = false
): Mounted => {
  const requests: Array<typeof payloadSchema.Type> = [];
  const clipboard = makeSensitiveClipboardSpy();
  const transport = HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (effect) =>
      Effect.flatMap(effect, (request) => {
        if (request.method === "POST") {
          if (request.body._tag === "Uint8Array") {
            requests.push(
              Schema.decodeSync(payloadSchema)(new TextDecoder().decode(request.body.body))
            );
          }
          return respond().pipe(
            Effect.map((response) => HttpClientResponse.fromWeb(request, response))
          );
        }
        return Effect.succeed(HttpClientResponse.fromWeb(request, currentUserResponse()));
      }),
    Effect.succeed
  );
  const apiClient = makeFidyClient({
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, transport),
  });
  const content = (key: string): JSX.Element => (
    <StrictMode>
      <RegistryProvider>
        <ManualPATCreation
          key={key}
          apiClient={apiClient}
          clipboard={clipboard}
          resuming={resuming}
        />
      </RegistryProvider>
    </StrictMode>
  );
  const rendered = render(content("initial"));
  return {
    ...rendered,
    requests,
    clipboard,
    replace: (): void => rendered.rerender(content("replacement")),
  };
};
const review = (): void => {
  fireEvent.change(screen.getByLabelText("Nombre"), {
    target: { value: "  Automatización casa  " },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Lectura/iu }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Tablero/iu }));
  fireEvent.click(screen.getByRole("button", { name: "Crear token" }));
};
const confirm = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear token" }));
};
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

it.effect(
  "reviews the exact grant before one issuance, supports copy and expires private disclosure",
  Effect.fnUntraced(function* () {
    const { requests, clipboard } = mount();
    expect(screen.getByRole("button", { name: "Crear token" })).toBeDisabled();
    review();
    expect(screen.getByRole("heading", { name: "Revisa el acceso" })).toBeVisible();
    expect(requests).toHaveLength(0);
    confirm();
    yield* Effect.tryPromise(() => screen.findByText(bearer));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.grant).toEqual({
      recipientLabel: "Automatización casa",
      scopes: ["read", "dashboard"],
      lifetimeDays: 90,
    });
    expect(requests[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    fireEvent.click(screen.getByRole("button", { name: "Copiar token" }));
    expect(clipboard.copy).toHaveBeenCalledWith(bearer, expect.any(Function));
    expect(screen.getByRole("button", { name: "Copiado" })).toBeVisible();
    act(() => clipboard.reveal.mock.calls[0]?.[0]());
    expect(screen.queryByText(bearer)).not.toBeInTheDocument();
    expect(clipboard.clear).toHaveBeenCalledWith(bearer);
  })
);

it.effect(
  "preserves the request identity only for explicit retry and creates a new review after editing",
  Effect.fnUntraced(function* () {
    const { requests } = mount(() => Effect.succeed(new Response(null, { status: 503 })));
    review();
    confirm();
    yield* Effect.tryPromise(() => screen.findByText("No pudimos crear el token"));
    fireEvent.click(screen.getByRole("button", { name: "Volver a la revisión" }));
    confirm();
    yield* Effect.tryPromise(() => screen.findByText("No pudimos crear el token"));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.requestId).toBe(requests[0]?.requestId);
    fireEvent.click(screen.getByRole("button", { name: "Volver a la revisión" }));
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getByLabelText("Nombre")).toHaveValue("Automatización casa");
    fireEvent.click(screen.getByRole("button", { name: "Crear token" }));
    confirm();
    yield* Effect.tryPromise(() => screen.findByText("No pudimos crear el token"));
    expect(requests[2]?.requestId).not.toBe(requests[0]?.requestId);
  })
);

it.effect(
  "retains choices on identity refusal and reports storage failure without navigation or issuance",
  Effect.fnUntraced(function* () {
    const { requests } = mount(() => Effect.sync(needsIdentity));
    review();
    confirm();
    yield* Effect.tryPromise(() => screen.findByText("Confirma tu identidad"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar mi identidad" }));
    expect(screen.getByText(/No pudimos conservar el formulario/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Volver al formulario" }));
    expect(screen.getByLabelText("Nombre")).toHaveValue("Automatización casa");
    expect(screen.getByRole("checkbox", { name: /Lectura/iu })).toBeChecked();
    expect(requests).toHaveLength(1);
    expect(screen.queryByText(bearer)).not.toBeInTheDocument();
  })
);

it.effect(
  "restores same-User choices into a fresh review without issuing, including Strict Mode replay",
  Effect.fnUntraced(function* () {
    preservePATDraft({
      userId,
      draft: {
        recipientLabel: PATRecipientLabel.make("Restaurado"),
        scopes: PATScopes.make(["read"]),
        lifetimeDays: PATLifetimeDays.make(restoreLifetime),
      },
    });
    const { requests } = mount(undefined, true);
    yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Revisa el acceso" }));
    expect(screen.getByText("Restaurado")).toBeVisible();
    expect(requests).toHaveLength(0);
    expect(window.sessionStorage.length).toBe(0);
  })
);

const deliverPending = (
  pending: PromiseWithResolvers<Response>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    Promise.resolve(
      act(() => {
        pending.resolve(issued());
        return pending.promise.then(() => undefined);
      })
    )
  );

it.effect(
  "discards a late issuance response after the mounted owner is replaced",
  Effect.fnUntraced(function* () {
    const pending = Promise.withResolvers<Response>();
    const { requests, clipboard, replace } = mount(() =>
      Effect.tryPromise(() => pending.promise).pipe(Effect.orDie)
    );
    review();
    confirm();
    yield* Effect.tryPromise(() => waitFor(() => expect(requests).toHaveLength(1)));
    replace();
    yield* deliverPending(pending);
    expect(screen.queryByText(bearer)).not.toBeInTheDocument();
    expect(clipboard.reveal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Crear token" })).toBeDisabled();
  })
);

it.effect.each(["reset", "pagehide", "replacement"] as const)(
  "clears a disclosed bearer on %s",
  (cause) =>
    Effect.gen(function* () {
      const { clipboard, replace } = mount();
      review();
      confirm();
      yield* Effect.tryPromise(() => screen.findByText(bearer));
      if (cause === "reset") {
        fireEvent.click(screen.getByRole("button", { name: "Crear otro token" }));
      } else if (cause === "replacement") replace();
      else {
        act(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
      }
      expect(screen.queryByText(bearer)).not.toBeInTheDocument();
      expect(clipboard.clear).toHaveBeenCalledWith(bearer);
    })
);

it.effect(
  "offers every fixed lifetime and preserves selection when editing a review",
  Effect.fnUntraced(function* () {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Duración del token" }));
    for (const days of patLifetimeDayOptions) {
      const preset = yield* Effect.tryPromise(() =>
        screen.findByRole("menuitemradio", { name: `${days} días` })
      );
      expect(preset).toBeVisible();
    }
    fireEvent.click(screen.getByRole("menuitemradio", { name: "30 días" }));
    review();
    expect(screen.getByText("30 días", { selector: "dd" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getByRole("button", { name: "Duración del token" })).toHaveTextContent("30 días");
  })
);
