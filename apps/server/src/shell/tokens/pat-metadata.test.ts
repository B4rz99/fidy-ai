import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { expect } from "vitest";
import { Unavailable } from "~/shell/public-http/contract";
import { preparePATMetadata } from "./operations";

it.effect.each(["created_at_ms", "last_used_at_ms", "expires_at_ms"])(
  "closes an out-of-range retained PAT %s into typed unavailable rather than a defect",
  (field) =>
    Effect.gen(function* () {
      const read = preparePATMetadata({
        userId: "10000000-0000-4000-8000-000000000001",
        current: 1000,
        authority: {
          table: "web_sessions",
          predicate: "user_id = ?",
          bindings: ["10000000-0000-4000-8000-000000000001"],
        },
      });
      const row = {
        short_id: "abcdefgh",
        recipient_label: "Agent",
        scopes_json: '["read"]',
        created_at_ms: 1000,
        last_used_at_ms: null,
        expires_at_ms: 604801000,
      };
      expect((yield* read.decode([row])).data.pats).toHaveLength(1);
      const exit = yield* read.decode([{ ...row, [field]: 1e20 }]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(Unavailable);
      }
    })
);
