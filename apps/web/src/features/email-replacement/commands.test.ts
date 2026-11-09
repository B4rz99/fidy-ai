// @vitest-environment jsdom

import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { makeFidyClient, makeWebAuthClient } from "@/transport/client";
import { makeReplacement } from "./commands";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const resources: Array<() => void> = [];
afterEach(() => {
  resources.reverse().forEach((dispose) => dispose());
  resources.length = 0;
  vi.useRealTimers();
  sessionStorage.clear();
});
const binding = "10000000-0000-4000-8000-000000000001";
const fixture = (
  {
    observedBinding,
    bindingWait,
  }: Readonly<{ observedBinding: string; bindingWait: Promise<void> }> = {
    observedBinding: binding,
    bindingWait: Promise.resolve(),
  }
): Readonly<{
  interaction: ReturnType<typeof makeReplacement>;
  dispatch: Parameters<ReturnType<typeof makeReplacement>["actions"]>[0];
  sent: Array<{ path: string; body: string }>;
}> => {
  vi.useFakeTimers();
  const sent: Array<{ path: string; body: string }> = [];
  const http = HttpClient.make((request) => {
    const path = new URL(request.url).pathname;
    sent.push({
      path,
      body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    });
    return (
      path === "/web/session/binding"
        ? Effect.tryPromise({
            try: () => bindingWait,
            catch: () =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: "synthetic binding unavailable",
                }),
              }),
          })
        : Effect.void
    ).pipe(
      Effect.as(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            encodeJson(
              path === "/web/session/binding"
                ? { binding: observedBinding }
                : {
                    data: { status: path.endsWith("verify") ? "replaced" : "pending" },
                    next: [],
                  }
            ),
            { headers: { "content-type": "application/json" } }
          )
        )
      )
    );
  });
  const apiClient = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, http),
  });
  const registry = AtomRegistry.make();
  const interaction = makeReplacement({
    apiClient,
    webAuthClient: makeWebAuthClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    }),
    publish: () => undefined,
    uncertain: false,
    onUncertain: () => undefined,
    binding,
  });
  const dispatch: Parameters<typeof interaction.actions>[0] = (input) =>
    registry.set(interaction.atom, input);
  resources.push(
    () => registry.dispose(),
    registry.mount(interaction.atom),
    interaction.mount(dispatch)
  );
  return { interaction, dispatch, sent };
};

it.effect(
  "rejects retained replacement intentions after another candidate owns the generation",
  () =>
    Effect.gen(function* () {
      const { interaction, dispatch, sent } = fixture();
      interaction.actions(dispatch).request("first@example.test");
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      const retired = interaction.actions(dispatch);
      retired.restart();
      interaction.actions(dispatch).request("second@example.test");
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      const code = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
      retired.complete(code);
      retired.repeat();
      retired.restart();
      retired.request("third@example.test");
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(sent.map((request) => request.body)).toEqual([
        encodeJson({ candidateEmail: "first@example.test" }),
        encodeJson({ candidateEmail: "second@example.test" }),
      ]);
      interaction.actions(dispatch).complete(code);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(sent).toHaveLength(4);
      expect(sent[2]).toEqual({
        path: "/web/session/binding",
        body: "",
      });
      expect(sent[3]).toEqual({
        path: "/web/email/replacement/verify",
        body: encodeJson({ candidateEmail: "second@example.test", combinedCode: code }),
      });
    })
);

it.effect(
  "preserves another session's unresolved admission when the live binding rejects this owner",
  () =>
    Effect.gen(function* () {
      const foreignBinding = "10000000-0000-4000-8000-000000000002";
      const marker = encodeJson({ version: 1, binding: foreignBinding });
      sessionStorage.setItem("fidy:email-replacement-admission-v1", marker);
      const { interaction, dispatch, sent } = fixture({
        observedBinding: foreignBinding,
        bindingWait: Promise.resolve(),
      });
      expect(sessionStorage.getItem("fidy:email-replacement-admission-v1")).toBe(marker);
      interaction.actions(dispatch).request("candidate@example.test");
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      interaction.actions(dispatch).complete("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ");
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(sent.map((request) => request.path)).toEqual([
        "/email/replacement",
        "/web/session/binding",
      ]);
      expect(sessionStorage.getItem("fidy:email-replacement-admission-v1")).toBe(marker);
    })
);

it.effect(
  "cannot overwrite another session's admission after leaving a pending binding observation",
  () =>
    Effect.gen(function* () {
      const marker = encodeJson({ version: 1, binding: "10000000-0000-4000-8000-000000000002" });
      sessionStorage.setItem("fidy:email-replacement-admission-v1", marker);
      const reply = Promise.withResolvers<void>();
      const { interaction, dispatch, sent } = fixture({
        observedBinding: binding,
        bindingWait: reply.promise,
      });
      interaction.actions(dispatch).request("candidate@example.test");
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      interaction.actions(dispatch).complete("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ");
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      interaction.actions(dispatch).restart();
      reply.resolve();
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(sent.map((request) => request.path)).toEqual([
        "/email/replacement",
        "/web/session/binding",
      ]);
      expect(sessionStorage.getItem("fidy:email-replacement-admission-v1")).toBe(marker);
    })
);
