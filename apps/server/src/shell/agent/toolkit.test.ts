import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { McpServer, Tool } from "effect/unstable/ai";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { FidyApi as ClientFidyApi } from "~/client";
import { categoryIds } from "~/core/categories/taxonomy";
import { assertCanonicalOperationRegistry } from "~/shell/_shared/canonical-operation-registry";
import { FidyApi } from "~/shell/api";
import {
  AgentToolkit,
  agentOperationBindings,
  decodeAgentOperationInput,
  findAgentOperationBinding,
} from "./toolkit";

const hostedTool = (name: string): Tool.AnyDynamic => {
  const tool = Object.values(AgentToolkit.tools).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Hosted tool is missing: ${name}`);
  return tool;
};

const mcpProbeHandlersDefinition: {
  [Name in keyof typeof AgentToolkit.tools]: () => Effect.Effect<never>;
} = Object.fromEntries(
  Object.keys(AgentToolkit.tools).map((name) => [
    name,
    (): Effect.Effect<never> => Effect.die("MCP registration probe must not invoke a handler"),
  ])
);
const mcpProbeHandlers = AgentToolkit.of(mcpProbeHandlersDefinition);

it("derives exactly one hosted tool for every FidyApi canonical operation", () => {
  const reflected: Array<string> = [];
  HttpApi.reflect(FidyApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group }) => {
      reflected.push(`${group.identifier}.${endpoint.identifier}`);
    },
  });

  assertCanonicalOperationRegistry(reflected);
  expect(agentOperationBindings.map(({ operation }) => operation)).toEqual(reflected);
  expect(Object.keys(AgentToolkit.tools)).toEqual(
    reflected.map((operation) => operation.replaceAll(".", "__"))
  );
  expect(agentOperationBindings.every(({ description }) => description.length > 0)).toBe(true);
});

it("rejects names outside the provider-safe operation vocabulary", () => {
  expect(Option.isNone(findAgentOperationBinding("not a provider tool"))).toBe(true);
});

it("derives exact canonical Memory identities across API, client, OpenAPI, hosted, and MCP", () => {
  const canonicalMemoryOperations = [
    "memory.remember",
    "memory.revise",
    "memory.forget",
    "memory.recall",
  ];
  const hostedMemoryOperations = Object.keys(AgentToolkit.tools)
    .filter((name) => name.startsWith("memory__"))
    .map((name) => name.replace("__", "."));
  const openApiMemoryOperations = Object.values(OpenApi.fromApi(FidyApi).paths)
    .flatMap((path) => Object.values(path))
    .flatMap((operation) => ("operationId" in operation ? [operation.operationId] : []))
    .filter(
      (operation): operation is string =>
        typeof operation === "string" && operation.startsWith("memory.")
    );

  expect(ClientFidyApi).toBe(FidyApi);
  expect(agentOperationBindings.map(({ operation }) => operation)).toEqual(
    expect.arrayContaining(canonicalMemoryOperations)
  );
  expect(hostedMemoryOperations).toEqual(canonicalMemoryOperations);
  expect(openApiMemoryOperations.toSorted()).toEqual(canonicalMemoryOperations.toSorted());
  expect(() => McpServer.toolkit(AgentToolkit)).not.toThrow();
});

it.effect("registers every canonical operation and schema through the MCP toolkit layer", () =>
  Effect.gen(function* () {
    const context = yield* Effect.scoped(
      Layer.build(
        Layer.merge(McpServer.McpServer.layer, McpServer.toolkit(AgentToolkit)).pipe(
          Layer.provide(AgentToolkit.toLayer(mcpProbeHandlers))
        )
      )
    );
    const server = Context.get(context, McpServer.McpServer);
    const registered = server.tools.map(({ tool }) => tool);

    expect(registered.map(({ name }) => name)).toEqual(Object.keys(AgentToolkit.tools));
    for (const tool of registered) {
      const hosted = hostedTool(tool.name);
      expect(tool.description).toBe(Tool.getDescription(hosted));
      expect(tool.inputSchema).toEqual(Tool.getJsonSchema(hosted));
    }
  })
);

it("encodes every hosted operation with its derived OpenAI wire schema", () => {
  for (const binding of agentOperationBindings) {
    const parameters = Tool.getJsonSchema(hostedTool(binding.wireName), {
      transformer: toCodecOpenAI,
    });
    expect(parameters).toEqual(binding.wireJsonSchema);
    expect(parameters.type).toBe("object");
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.additionalProperties).toBe(false);
  }
});

it.effect("decodes strict-mode nullable optional fields back to absent canonical input", () =>
  Effect.gen(function* () {
    const binding = agentOperationBindings.find(
      ({ operation }) => operation === "transactions.createTransaction"
    );
    if (binding === undefined) return yield* Effect.die("Create Transaction binding is missing");

    const decoded = yield* decodeAgentOperationInput(binding, {
      payload: {
        money: { amount: "9000", currency: "COP" },
        counterparty: null,
        direction: "outflow",
        categoryId: categoryIds.restaurantes,
        notes: null,
        occurredAt: "2026-07-20T12:00:00Z",
      },
    });
    const canonical = yield* Schema.encodeUnknownEffect(binding.canonicalParameters)(decoded);

    expect(canonical).toEqual({
      payload: {
        money: { amount: "9000", currency: "COP" },
        direction: "outflow",
        categoryId: categoryIds.restaurantes,
        occurredAt: "2026-07-20T12:00:00.000Z",
      },
    });
  })
);

it("tells the hosted model which transaction operations need confirmation", () => {
  const createDescription = Tool.getDescription(hostedTool("transactions__createTransaction"));
  const deleteDescription = Tool.getDescription(hostedTool("transactions__deleteTransaction"));

  expect(createDescription).toContain("does not require User confirmation");
  expect(deleteDescription).toContain("host manages exact confirmation");
});
