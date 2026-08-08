import { expect, layer } from "@effect/vitest";
import { Cause, Effect, Exit, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { defaultUserId } from "./development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { withUserTransaction } from "./user-transaction";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "User-scoped transactions",
  (it) => {
    it.effect("rejects a nested transaction that switches User context", () =>
      Effect.gen(function* () {
        const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000a42");
        const exit = yield* Effect.exit(
          withUserTransaction(defaultUserId, withUserTransaction(otherUserId, Effect.void))
        );

        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      })
    );

    it.effect("surfaces a statement UniqueViolation as a typed outcome", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const entryId = "f1d1a000-0000-4000-8000-000000000a40";
        const turnId = "f1d1a000-0000-4000-8000-000000000a41";
        const entry = `{"id":"${entryId}","turnId":"${turnId}"}`;
        const outcome = yield* Effect.result(
          withUserTransaction(
            defaultUserId,
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES (${defaultUserId}, ${entryId}, ${turnId}, ${entry}::jsonb)
              `;
              yield* sql`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES (${defaultUserId}, ${entryId}, ${turnId}, ${entry}::jsonb)
              `;
            })
          )
        );

        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isSuccess(outcome)) return yield* Effect.die("expected a typed SQL failure");
        expect(outcome.failure.reason._tag).toBe("UniqueViolation");
        if (outcome.failure.reason._tag === "UniqueViolation") {
          expect(outcome.failure.reason.constraint).toBe("transcript_entries_entry_id_key");
        }
      })
    );
  }
);
