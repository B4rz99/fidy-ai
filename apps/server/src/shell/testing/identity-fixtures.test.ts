import { expect, layer } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness } from "./api-harness";
import { upsertStableUserFixture } from "./identity-fixtures";

const userId = UserId.make("f1d1a000-0000-4000-8000-0000000008f1");

const clearFixture = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${userId}`;
      yield* sql`DELETE FROM users WHERE id = ${userId}`;
    })
  );
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "stable User fixtures",
  (it) => {
    it.effect("creates every mandatory owner record", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* clearFixture;
        const user = yield* makeColombianUser(userId, {
          createdAt: DateTime.makeUnsafe("2026-08-01T12:00:00Z"),
          paidTier: "free",
        });

        yield* upsertStableUserFixture(userId, user);

        expect(
          yield* sql`
            SELECT
              (SELECT count(*)::int FROM users WHERE id = ${userId}) AS users,
              (SELECT count(*)::int FROM whatsapp_identities WHERE user_id = ${userId}) AS identities,
              (SELECT count(*)::int FROM consent_records
                WHERE subject_user_id = ${userId} AND event_type = 'granted'
                  AND grant_type = 'onboarding') AS consent,
              (SELECT count(*)::int FROM verified_email_credentials
                WHERE user_id = ${userId}) AS email,
              (SELECT count(*)::int FROM backup_recovery_credentials
                WHERE user_id = ${userId}) AS recovery
          `
        ).toEqual([{ users: 1, identities: 1, consent: 1, email: 1, recovery: 1 }]);
      }).pipe(Effect.ensuring(clearFixture.pipe(Effect.orDie)))
    );
  }
);
