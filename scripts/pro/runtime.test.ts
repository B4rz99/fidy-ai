import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { expect } from "vitest";
import {
  ProCommand,
  ProGrantFailure,
  type ProOperatorCommand,
} from "../../apps/server/src/shell/pro-grants/contract";
import { runProCommand } from "./runtime";

const userId = "10000000-0000-4000-8000-000000000001",
  other = "10000000-0000-4000-8000-000000000002";

const unavailable = (): ProGrantFailure => new ProGrantFailure({ reason: "unavailable" });

const oversized = Array.from({ length: 1001 }, (_, index) => ({
  userId: "10000000-0000-4000-8000-" + String(index).padStart(12, "0"),
  action: "grant",
}));

const run = it.layer(SecureRandom.layerWebCrypto);

run((test) => {
  test.effect(
    "resolves a verified mailbox once and retries exactly its original command, User and mailbox generation",
    () =>
      Effect.gen(function* () {
        const sent: Array<typeof ProOperatorCommand.Type> = [];

        const command = yield* Schema.decodeEffect(ProCommand)({
          action: "grant",
          selector: { email: " Example@EXAMPLE.test " },
        });

        const result = yield* runProCommand(command, (request) => {
          sent.push(request);

          if (request.action === "resolve") return Effect.succeed({ userId, revision: 2 });

          return sent.length === 2
            ? Effect.fail(unavailable())
            : Effect.succeed({ userId, action: "grant" });
        });

        expect(result).toEqual([{ userId, action: "grant" }]);
        expect(sent[0]).toEqual({ action: "resolve", email: "example@example.test" });
        expect(sent[1]).toEqual(sent[2]);
        expect(sent[1]).toMatchObject({
          action: "grant",
          userId,
          mailbox: { email: "example@example.test", revision: 2 },
        });
      })
  );
  test.effect(
    "emits a complete sorted list only after every page succeeds and refuses a broken or overflowing traversal",
    () =>
      Effect.gen(function* () {
        const first = {
          entries: [{ userId: other, action: "grant" }],
          next: { after: 16, through: 32 },
        };

        const second = { entries: [{ userId, action: "grant" }], next: null };
        expect(
          yield* runProCommand({ action: "list" }, (cmd) =>
            Effect.succeed(cmd.action === "list" && cmd.cursor !== undefined ? second : first)
          )
        ).toEqual([second.entries[0], first.entries[0]]);

        const invalid = yield* Effect.result(
          runProCommand({ action: "list" }, () => Effect.succeed(first))
        );

        expect(invalid._tag).toBe("Failure");

        const overflow = yield* Effect.result(
          runProCommand({ action: "list" }, () =>
            Effect.succeed({
              entries: oversized,
              next: null,
            })
          )
        );

        expect(overflow._tag).toBe("Failure");

        const incomplete = yield* Effect.result(
          runProCommand({ action: "list" }, (cmd) =>
            cmd.action === "list" && cmd.cursor !== undefined
              ? Effect.fail(unavailable())
              : Effect.succeed(first)
          )
        );

        expect(incomplete._tag).toBe("Failure");
      })
  );
});
