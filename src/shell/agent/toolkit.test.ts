import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import { HttpApi } from "effect/unstable/httpapi";
import { FidyApi } from "~/shell/api";
import { AgentToolkit, CanonicalApiUrl, agentOperationBindings } from "./toolkit";

it("derives exactly one hosted tool for every FidyApi canonical operation", () => {
  const reflected: Array<string> = [];
  HttpApi.reflect(FidyApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group }) => {
      reflected.push(`${group.identifier}.${endpoint.identifier}`);
    },
  });

  expect(agentOperationBindings.map(({ operation }) => operation)).toEqual(reflected);
  expect(Object.keys(AgentToolkit.tools)).toEqual(
    reflected.map((operation) => operation.replaceAll(".", "__"))
  );
  expect(agentOperationBindings.every(({ description }) => description.length > 0)).toBe(true);
});

it("encodes every hosted operation as an OpenAI closed object", () => {
  for (const tool of Object.values(AgentToolkit.tools)) {
    const parameters = Tool.getJsonSchema(tool, { transformer: toCodecOpenAI });
    expect(parameters.type).toBe("object");
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.additionalProperties).toBe(false);
  }
});

it.effect("rejects canonical API destinations that could leak a hosted bearer", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(CanonicalApiUrl);
    yield* Effect.flip(decode("http://attacker.example"));
    yield* Effect.flip(decode("https://user:secret@localhost"));
    yield* Effect.flip(decode("https://api.example"));
    yield* Effect.flip(decode("http://localhost?redirect=attacker"));
    yield* Effect.flip(decode("http://localhost/proxy"));
    yield* Effect.flip(decode("http://localhost/#fragment"));
    expect((yield* decode("http://127.0.0.1:3000")).href).toBe("http://127.0.0.1:3000/");
    expect((yield* decode("https://localhost:3443")).href).toBe("https://localhost:3443/");
  })
);
