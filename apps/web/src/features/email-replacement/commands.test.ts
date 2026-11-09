// @vitest-environment jsdom

import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { makeReplacement } from "./commands";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const resources: Array<() => void> = [];
afterEach(() => {
  resources.reverse().forEach((dispose) => dispose());
  resources.length = 0;
  vi.useRealTimers();
});
const fixture = (): Readonly<{
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
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          encodeJson({
            data: { status: path.endsWith("verify") ? "replaced" : "pending" },
            next: [],
          }),
          { headers: { "content-type": "application/json" } }
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
    publish: () => undefined,
    uncertain: false,
    onUncertain: () => undefined,
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
      expect(sent).toHaveLength(3);
      expect(sent[2]).toEqual({
        path: "/web/email/replacement/verify",
        body: encodeJson({ candidateEmail: "second@example.test", combinedCode: code }),
      });
    })
);
