import { expect, layer } from "@effect/vitest";
import { Data, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness } from "~/shell/testing/api-harness";
import { keyPairingSourceAdmission } from "./0058-key-pairing-source-admission";

class RollbackMigrationFixture extends Data.TaggedError("RollbackMigrationFixture")<{}> {}

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Keyed pairing source admission migration",
  (it) => {
    it.effect(
      "deletes pre-keyed admission evidence and documents its admission-only semantics",
      () =>
        Effect.gen(function* () {
          const admin = yield* MigrationSqlClient;
          const result = yield* admin
            .withTransaction(
              Effect.gen(function* () {
                yield* admin`
                INSERT INTO browser_login_start_attempts (source_digest, attempted_at)
                VALUES (decode(repeat('11', 32), 'hex'), now());
                INSERT INTO pat_pairing_start_attempts (source_digest, attempted_at)
                VALUES (decode(repeat('22', 32), 'hex'), now());
                INSERT INTO pat_pairing_claim_attempts (source_digest, attempted_at)
                VALUES (decode(repeat('33', 32), 'hex'), now())
              `;

                yield* keyPairingSourceAdmission.pipe(
                  Effect.provideService(SqlClient.SqlClient, admin)
                );

                expect(
                  yield* admin`SELECT count(*)::int AS count FROM browser_login_start_attempts`
                ).toEqual([{ count: 0 }]);
                expect(
                  yield* admin`SELECT count(*)::int AS count FROM pat_pairing_start_attempts`
                ).toEqual([{ count: 0 }]);
                expect(
                  yield* admin`SELECT count(*)::int AS count FROM pat_pairing_claim_attempts`
                ).toEqual([{ count: 0 }]);
                const [comment] = yield* admin`
                SELECT col_description('browser_login_start_attempts'::regclass, attnum) AS comment
                FROM pg_attribute
                WHERE attrelid = 'browser_login_start_attempts'::regclass
                  AND attname = 'source_digest'
              `;
                expect(comment?.comment).toContain(
                  "abuse admission only; never identity or authorization evidence"
                );

                return yield* new RollbackMigrationFixture();
              })
            )
            .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

          expect(result).toBe("rolled back");
        })
    );
  }
);
