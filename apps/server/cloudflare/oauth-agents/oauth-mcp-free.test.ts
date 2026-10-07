import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  TokenFixture,
  approvedFixture,
  exchangeFixture,
  mcpFixture,
  wait,
} from "./oauth-ingress.test-fixture";

it.live(
  "stateless MCP discovery uses the User execution boundary on repeated requests without requiring a session",
  () =>
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const before = fixture.mcpHandoffs();
      for (let iteration = 0; iteration < 2; iteration++) {
        const response = yield* wait(
          mcpFixture({
            ...fixture,
            bearer: token.access_token,
            retryKey: Option.none(),
            method: "tools/list",
          })
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("mcp-session-id")).toBeNull();
        expect(yield* wait(response.json())).toHaveProperty("result.tools");
      }
      expect(fixture.mcpHandoffs() - before).toBe(2);
    })
);
