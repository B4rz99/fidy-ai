import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { operationCatalog } from "../../src/shell/api";
import {
  discoveryCases,
  excludedAccountSecurityDiscovery,
  readDiscovery,
  sensitiveDiscovery,
} from "./discovery.test-fixture";
import { native } from "../user-store.test-fixture";
import { nativeGrantWithScopes, protocolFor } from "./native-grant.test-fixture";

const ListedTools = Schema.Struct({
  result: Schema.Struct({
    cacheScope: Schema.Literal("private"),
    ttlMs: Schema.Literal(0),
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        inputSchema: Schema.Json,
        outputSchema: Schema.Json,
        annotations: Schema.Struct({
          readOnlyHint: Schema.Boolean,
          destructiveHint: Schema.Boolean,
        }),
      })
    ),
  }),
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect.each(
    discoveryCases.map((discovery) => ({ ...discovery, label: discovery.scopes.join(" and ") }))
  )("projects private MCP discovery for $label", ({ scopes, tools, additionalDeclarations }) =>
    Effect.gen(function* () {
      const { runtime, credential } = yield* nativeGrantWithScopes(scopes);
      const response = yield* protocolFor(runtime)(credential.access_token, "tools/list");
      expect(response.status).toBe(200);

      const listed = yield* Schema.decodeUnknownEffect(ListedTools)(
        yield* native(() => response.json())
      );

      const expected = [...tools].sort();
      const names = listed.result.tools.map(({ name }) => name);
      expect(names, scopes.join(" ")).toEqual(expected);

      for (const excluded of excludedAccountSecurityDiscovery) {
        expect(names).not.toContain(excluded);
      }

      for (const tool of listed.result.tools) {
        expect(tool.annotations).toEqual({
          readOnlyHint: readDiscovery.includes(tool.name),
          destructiveHint: sensitiveDiscovery.has(tool.name),
        });
      }

      const schemas = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
        listed.result.tools.map(({ inputSchema, outputSchema }) => ({
          inputSchema,
          outputSchema,
        }))
      );

      const allowedDeclarations = new Set([...tools, ...additionalDeclarations]);

      for (const operation of operationCatalog.operations.filter(
        ({ id }) => !allowedDeclarations.has(id)
      )) {
        expect(schemas).not.toContain(`"${operation.id}"`);
      }
    })
  );
});

const Listed2025Tools = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        inputSchema: Schema.Json,
        outputSchema: Schema.optionalKey(Schema.Json),
        annotations: Schema.Struct({
          readOnlyHint: Schema.Boolean,
          destructiveHint: Schema.Boolean,
        }),
      })
    ),
  }),
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "retains a 2025 MCP session across initialization, notification and scoped discovery",
    () =>
      Effect.gen(function* () {
        const { runtime, credential } = yield* nativeGrantWithScopes(["read"]);

        const headers = {
          "cf-connecting-ip": "192.0.2.75",
          authorization: `Bearer ${credential.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        };

        const initialized = yield* native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com/mcp", {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "initialize-resident",
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "resident-protocol-fixture", version: "1" },
              },
            }),
          })
        );

        expect(initialized.status).toBe(200);
        const sessionId = initialized.headers.get("mcp-session-id");
        expect(sessionId).not.toBeNull();
        yield* native(() => initialized.text());

        const sessionHeaders = {
          ...headers,
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": sessionId ?? "",
        };

        const notified = yield* native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com/mcp", {
            method: "POST",
            headers: sessionHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }),
          })
        );

        expect(notified.status).toBe(202);
        yield* native(() => notified.text());

        const discovery = yield* native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com/mcp", {
            method: "POST",
            headers: sessionHeaders,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "discover-resident",
              method: "tools/list",
              params: {},
            }),
          })
        );

        expect(discovery.status).toBe(200);

        const listed = yield* Schema.decodeUnknownEffect(Listed2025Tools)(
          yield* native(() => discovery.json())
        );

        expect(listed.result.tools.map(({ name }) => name)).toEqual(
          [...readDiscovery, "operations.executeAtomicBatch"].sort()
        );

        for (const tool of listed.result.tools) {
          expect(tool.annotations).toEqual(
            tool.name === "operations.executeAtomicBatch"
              ? expect.objectContaining({ readOnlyHint: false })
              : { readOnlyHint: true, destructiveHint: false }
          );
        }
      })
  );
});
