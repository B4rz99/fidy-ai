import { expect, layer } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { SqlClient, type SqlConnection, type Statement } from "effect/unstable/sql";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness } from "~/shell/testing/api-harness";
import { RollbackMigrationFixture } from "~/shell/testing/rollback-migration-fixture";
import { hmacKeyByteSemantics } from "./0060-hmac-key-byte-semantics";

const fixtureUserId = "f1d1a000-0000-4000-8000-0000000005b1";
const fixturePairingId = "f1d1a000-0000-4000-8000-0000000005b2";
const fixtureEmail = "migration-vector@example.com";
// OpenSSL dgst -sha256 -mac HMAC -macopt hexkey:abab...ab of the credential lookup scope.
const fixtureLookupIdentifier = "cb2939ae11f44e2f6ff30065939e4ef3ef449aed086eab2ea71868818e674546";
const createdUserId = "f1d1a000-0000-4000-8000-0000000005b3";
const createdEmail = "migration-created@example.com";
const createdLookupIdentifier = "205976dfa5b07f6468c0681b54df730866816b005b9bbf2e55a23939978714c5";
const legacyOneWayKey = "f".repeat(64);

const insertUser = (sql: SqlClient.SqlClient, id: string): Statement.Statement<SqlConnection.Row> =>
  sql`
    INSERT INTO users (
      id, service_market, locale, time_zone, created_at, trial_started_at, trial_ends_at
    ) VALUES (
      ${id}, 'CO', 'es-CO', 'America/Bogota', now(), now(), now() + interval '168 hours'
    )
  `;

const insertVerifiedCredential = (
  sql: SqlClient.SqlClient,
  userId: string,
  email: string
): Statement.Statement<SqlConnection.Row> =>
  sql`
    INSERT INTO verified_email_credentials (user_id, email_address, verified_at)
    VALUES (${userId}, ${email}, now())
  `;

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "HMAC key byte semantics migration",
  (it) => {
    it.effect("re-derives credential lookups and clears one-way scope evidence", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* insertUser(admin, fixtureUserId);
              yield* insertVerifiedCredential(admin, fixtureUserId, fixtureEmail);
              yield* admin`
                INSERT INTO verified_email_credential_authentication_lookups (
                  user_id, authentication_lookup_key
                ) VALUES (${fixtureUserId}, ${legacyOneWayKey})
              `;
              yield* insertUser(admin, createdUserId);
              yield* insertVerifiedCredential(admin, createdUserId, createdEmail);
              yield* admin`
                INSERT INTO email_delivery_admission_budgets (scope_key, delivery_count, expires_at)
                VALUES (${legacyOneWayKey}, 0, now() + interval '1 hour')
              `;
              yield* admin`
                INSERT INTO email_pairing_login_admission_scopes (
                  scope_key, scope_kind, expires_at
                ) VALUES (${legacyOneWayKey}, 'address', now() + interval '1 hour')
              `;
              yield* admin`
                INSERT INTO email_pairing_login_admission_attempts (scope_key, attempted_at)
                VALUES (${legacyOneWayKey}, now())
              `;
              yield* admin`
                INSERT INTO browser_login_pairings (
                  id, public_code, verifier_digest, created_at, expires_at
                ) VALUES (
                  ${fixturePairingId}, 'BCDF-GHJK', decode(repeat('00', 32), 'hex'),
                  now(), now() + interval '10 minutes'
                )
              `;
              yield* admin`
                INSERT INTO browser_pairing_email_start_requests (
                  id, pairing_id, address_lookup_key, requested_at, expires_at
                ) VALUES (
                  gen_random_uuid(), ${fixturePairingId}, ${legacyOneWayKey},
                  now(), now() + interval '10 minutes'
                )
              `;
              yield* admin`
                INSERT INTO browser_login_start_attempts (source_digest, attempted_at)
                VALUES (decode(repeat('00', 32), 'hex'), now())
              `;
              yield* admin`
                INSERT INTO pat_pairing_start_attempts (source_digest, attempted_at)
                VALUES (decode(repeat('00', 32), 'hex'), now())
              `;
              yield* admin`
                INSERT INTO pat_pairing_claim_attempts (source_digest, attempted_at)
                VALUES (decode(repeat('00', 32), 'hex'), now())
              `;

              yield* hmacKeyByteSemantics.pipe(
                Effect.provideService(SqlClient.SqlClient, admin),
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({
                    env: {
                      NODE_ENV: "production",
                      EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY: "ab".repeat(32),
                    },
                  })
                )
              );

              expect(
                yield* admin`
                  SELECT user_id::text AS "userId",
                    authentication_lookup_key AS "authenticationLookupKey"
                  FROM verified_email_credential_authentication_lookups
                  WHERE user_id = ${fixtureUserId}
                `
              ).toEqual([
                { userId: fixtureUserId, authenticationLookupKey: fixtureLookupIdentifier },
              ]);
              expect(
                yield* admin`
                  SELECT user_id::text AS "userId",
                    authentication_lookup_key AS "authenticationLookupKey"
                  FROM verified_email_credential_authentication_lookups
                  WHERE user_id = ${createdUserId}
                `
              ).toEqual([
                { userId: createdUserId, authenticationLookupKey: createdLookupIdentifier },
              ]);
              expect(
                yield* admin`SELECT count(*)::int AS count FROM email_delivery_admission_budgets`
              ).toEqual([{ count: 0 }]);
              expect(
                yield* admin`SELECT count(*)::int AS count FROM email_pairing_login_admission_scopes`
              ).toEqual([{ count: 0 }]);
              expect(
                yield* admin`SELECT count(*)::int AS count FROM email_pairing_login_admission_attempts`
              ).toEqual([{ count: 0 }]);
              expect(
                yield* admin`SELECT count(*)::int AS count FROM browser_pairing_email_start_requests`
              ).toEqual([{ count: 0 }]);
              expect(
                yield* admin`SELECT count(*)::int AS count FROM browser_login_start_attempts`
              ).toEqual([{ count: 0 }]);
              expect(
                yield* admin`SELECT count(*)::int AS count FROM pat_pairing_start_attempts`
              ).toEqual([{ count: 0 }]);
              expect(
                yield* admin`SELECT count(*)::int AS count FROM pat_pairing_claim_attempts`
              ).toEqual([{ count: 0 }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
        const [rolledBack] = yield* admin<{ readonly count: number }>`
          SELECT count(*)::int AS count
          FROM verified_email_credential_authentication_lookups
          WHERE user_id = ${fixtureUserId}
        `;
        expect(rolledBack).toEqual({ count: 0 });
      })
    );
  }
);
