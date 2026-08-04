import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import { HttpApi } from "effect/unstable/httpapi";
import { FidyApi } from "~/shell/api";
import { AgentToolkit, CanonicalApiUrl, agentOperationBindings } from "./toolkit";

const hostedTool = (name: string) => {
  const tool = Object.values(AgentToolkit.tools).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Hosted tool is missing: ${name}`);
  return tool;
};

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

it("tells the hosted model which transaction operations need confirmation", () => {
  const createDescription = Tool.getDescription(hostedTool("transactions__createTransaction"));
  const deleteDescription = Tool.getDescription(hostedTool("transactions__deleteTransaction"));

  expect(createDescription).toContain("does not require User confirmation");
  expect(deleteDescription).toContain("host manages exact confirmation");
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
