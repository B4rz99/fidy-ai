import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness } from "~/shell/testing/api-harness";
import { upsertStableUserFixture } from "~/shell/testing/identity-fixtures";
import { findUser, upsertDevelopmentUser } from "./repo";

const userId = UserId.make("f1d1a000-0000-4000-8000-0000000008e1");
const originalCreatedAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "identity persistence",
  (it) => {
    it.effect("preserves the one-time TrialPeriod when a User is upserted", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM users WHERE id = ${userId}`;
        const original = yield* makeColombianUser(userId, {
          createdAt: originalCreatedAt,
          paidTier: "free",
        });
        yield* upsertStableUserFixture(userId, original);

        const attemptedReplacement = yield* makeColombianUser(userId, {
          createdAt: DateTime.makeUnsafe("2026-09-01T12:00:00Z"),
          paidTier: "pro",
        });
        const upserted = yield* upsertDevelopmentUser(userId, attemptedReplacement);
        const persisted = Option.getOrThrow(yield* findUser(userId));

        expect(upserted).toMatchObject({
          paidTier: "pro",
          trialPeriod: original.trialPeriod,
          createdAt: originalCreatedAt,
        });
        expect(persisted).toEqual(upserted);
      })
    );
  }
);
