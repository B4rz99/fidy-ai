import assert from "node:assert/strict";
import { expect, layer } from "@effect/vitest";
import { Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { SqlClient } from "effect/unstable/sql";
import {
  BackupRecoveryCode,
  RotatedBackupRecoveryCode,
  SupportOperatorId,
  SupportRecoveryCaseEventId,
  SupportRecoveryCaseId,
} from "~/core/recovery/model";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import { approveBrowserLoginPairing } from "~/shell/browser-login/mutations";
import {
  approveBrowserLoginPairingForExistingUserInScope,
  approveBrowserLoginPairingWithPrivateVerifierInScope,
} from "~/shell/browser-login/service";
import { UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { withSubjectLockInScope } from "~/shell/consent/repo";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { MigrationSqlClient } from "~/shell/db/client";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { upsertStableUserFixture } from "~/shell/testing/identity-fixtures";
import { ApiHarness, makeApiHarnessWithSupportAccess } from "~/shell/testing/api-harness";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { SupportAccessVerifier, makeSupportAccessVerifier } from "./access";
import { SupportRecoveryOperationalFailure, approveSupportRecovery } from "./service";
import {
  admitSupportRecoveryInvocation,
  deleteExpiredSupportRecoveryEvidence,
  deleteSupportRecoveryForTitular,
  expireDueSupportRecoveryCases,
  findOpenSupportRecoveryCase,
  insertSupportRecoveryCase,
  purgeSupportRecoveryAdmissionEvidence,
  rejectSupportRecoveryCase,
  upsertDevelopmentBackupRecoveryCredentialInScope,
} from "./repo";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000a31");
const expiringUserId = UserId.make("f1d1a000-0000-4000-8000-000000000a32");
const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000a33");
const recoveryCode = BackupRecoveryCode.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2");
const expiringRecoveryCode = BackupRecoveryCode.make("BCDEF-GHJKL-MNPQR-STUVW-XYZ23");
const otherRecoveryCode = BackupRecoveryCode.make("CDEFG-HJKLM-NPQRS-TUVWX-YZ234");
const accessHeader = { "cf-access-jwt-assertion": "test-support-access-token" };
const secondsPerMinute = 60;
const millisecondsPerSecond = 1_000;
const futureIssuedAtMinutes = 60;
const accessAssertionLifetimeMinutes = 15;
const oversizedSupportPayloadBytes = 5_000;

const installStableRecoveryFixture = (
  targetUserId: UserId,
  targetRecoveryCode: BackupRecoveryCode
): Effect.Effect<void, never, Crypto.Crypto | MigrationSqlClient | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const createdAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
    yield* upsertStableUserFixture(
      targetUserId,
      yield* makeColombianUser(targetUserId, { createdAt, paidTier: "free" })
    );
    const crypto = yield* Crypto.Crypto;
    const codeDigest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(targetRecoveryCode))
      .pipe(Effect.orDie);
    yield* withUserTransaction(
      targetUserId,
      upsertDevelopmentBackupRecoveryCredentialInScope({
        userId: targetUserId,
        codeDigest,
        createdAt,
      })
    );
  }).pipe(Effect.orDie);

const prepare = (
  targetUserId: UserId,
  targetRecoveryCode: BackupRecoveryCode
): Effect.Effect<void, never, Crypto.Crypto | MigrationSqlClient | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* MigrationSqlClient;
    yield* sql`DELETE FROM web_sessions`;
    yield* sql`DELETE FROM browser_login_start_attempts`;
    yield* sql`DELETE FROM browser_login_pairings`;
    yield* sql`DELETE FROM support_recovery_admission_attempts`;
    yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${targetUserId}`;
    yield* installStableRecoveryFixture(targetUserId, targetRecoveryCode);
  }).pipe(Effect.orDie);

const startPairing = Effect.fn("Testing.startSupportPairing")(function* (fingerprint: string) {
  const response = yield* HttpClient.post("/web/pairings", {
    headers: { "user-agent": `fidy-support-recovery-test/${fingerprint}` },
  });
  assert.equal(response.status, 200);
  return yield* Schema.decodeUnknownEffect(StartedBrowserLoginPairing)(yield* response.json);
});

const support = (pairingCode: string, code: string): ReturnType<typeof HttpClient.post> =>
  HttpClient.post("/internal/support-recovery", {
    headers: accessHeader,
    body: HttpBody.jsonUnsafe({ pairingCode, backupRecoveryCode: code }),
  });

const redeem = (pairing: StartedBrowserLoginPairing): ReturnType<typeof HttpClient.post> =>
  HttpClient.post("/web/pairings/redeem", {
    body: HttpBody.jsonUnsafe({
      pairingId: pairing.pairingId,
      privateVerifier: Redacted.value(pairing.privateVerifier),
    }),
  });

const RecoveryHarness = ApiHarness.pipe(Layer.provideMerge(TelemetryDisabled));

class RealAccessTestSigningKey extends Context.Service<
  RealAccessTestSigningKey,
  Readonly<{ privateKey: CryptoKey }>
>()("@fidy/server/shell/recovery/recovery.test/RealAccessTestSigningKey") {}

const realAccessIssuer = "https://fidy.cloudflareaccess.com";
const realAccessAudience = "support-recovery-audience";
const signFutureAccessAssertion = (privateKey: CryptoKey): Effect.Effect<string> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const issuedAt =
      Math.floor(now.epochMilliseconds / millisecondsPerSecond) +
      futureIssuedAtMinutes * secondsPerMinute;
    return yield* Effect.promise(() =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "support-key" })
        .setIssuer(realAccessIssuer)
        .setAudience(realAccessAudience)
        .setSubject("operator-42")
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + accessAssertionLifetimeMinutes * secondsPerMinute)
        .sign(privateKey)
    );
  });
const RealAccessTestLive = Layer.effectContext(
  Effect.gen(function* () {
    const pair = yield* Effect.promise(() => generateKeyPair("RS256"));
    const jwk = yield* Effect.promise(() => exportJWK(pair.publicKey));
    return Context.empty().pipe(
      Context.add(
        SupportAccessVerifier,
        makeSupportAccessVerifier({
          issuer: realAccessIssuer,
          audience: realAccessAudience,
          jwks: createLocalJWKSet({ keys: [{ ...jwk, kid: "support-key", alg: "RS256" }] }),
        })
      ),
      Context.add(RealAccessTestSigningKey, { privateKey: pair.privateKey })
    );
  })
);
const RealAccessRecoveryHarness = Layer.merge(
  makeApiHarnessWithSupportAccess(RealAccessTestLive),
  RealAccessTestLive
);

layer(RecoveryHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "support recovery",
  (it) => {
    it.effect("authenticates and counts every bounded invocation before decoding its body", () =>
      Effect.gen(function* () {
        const unauthenticated = yield* HttpClient.post("/internal/support-recovery", {
          body: HttpBody.text("not-json", "application/json"),
        });
        expect(unauthenticated.status).toBe(401);
        const invalidAssertion = yield* HttpClient.post("/internal/support-recovery", {
          headers: { "cf-access-jwt-assertion": "invalid-support-access-token" },
        });
        const missingPayload = yield* HttpClient.post("/internal/support-recovery", {
          headers: accessHeader,
        });
        const oversizedPayload = yield* HttpClient.post("/internal/support-recovery", {
          headers: accessHeader,
          body: HttpBody.text("x".repeat(oversizedSupportPayloadBytes), "application/json"),
        });
        const malformed = yield* Effect.all(
          Array.from({ length: 4 }, () =>
            HttpClient.post("/internal/support-recovery", {
              headers: accessHeader,
              body: HttpBody.text("not-json", "application/json"),
            })
          )
        );
        expect(invalidAssertion.status).toBe(401);
        expect(missingPayload.status).toBe(400);
        expect(oversizedPayload.status).toBe(400);
        expect(malformed.map(({ status }) => status)).toEqual([400, 400, 400, 429]);
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
            SELECT sum(invocation_count)::int AS count
            FROM support_recovery_admission_attempts
          `
        ).toEqual([{ count: 6 }]);
      })
    );

    it.effect("uses exact instants for rolling admission and one-hour evidence retention", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM support_recovery_admission_attempts`;
        const operatorId = SupportOperatorId.make({
          issuer: "https://test.cloudflareaccess.com",
          subject: "fractional-window-operator",
        });
        const openedAt = DateTime.makeUnsafe("2026-08-01T12:00:00.500Z");
        const nearMinuteBoundary = DateTime.makeUnsafe("2026-08-01T12:01:00.499Z");
        const minuteBoundary = DateTime.makeUnsafe("2026-08-01T12:01:00.500Z");

        const admitted = yield* Effect.all(
          Array.from({ length: 5 }, () => admitSupportRecoveryInvocation(operatorId, openedAt)),
          { concurrency: 1 }
        );
        expect(admitted.map(({ _tag }) => _tag)).toEqual(
          Array.from({ length: 5 }, () => "Admitted")
        );
        expect((yield* admitSupportRecoveryInvocation(operatorId, nearMinuteBoundary))._tag).toBe(
          "Limited"
        );
        expect((yield* admitSupportRecoveryInvocation(operatorId, minuteBoundary))._tag).toBe(
          "Admitted"
        );

        yield* purgeSupportRecoveryAdmissionEvidence(
          DateTime.makeUnsafe("2026-08-01T13:00:00.499Z")
        );
        expect(
          yield* sql`
            SELECT sum(invocation_count)::int AS count
            FROM support_recovery_admission_attempts
            WHERE attempted_at = ${openedAt}
          `
        ).toEqual([{ count: 5 }]);
        yield* purgeSupportRecoveryAdmissionEvidence(
          DateTime.makeUnsafe("2026-08-01T13:00:00.500Z")
        );
        expect(
          yield* sql`
            SELECT count(*)::int AS count FROM support_recovery_admission_attempts
            WHERE attempted_at = ${openedAt}
          `
        ).toEqual([{ count: 0 }]);
      })
    );

    it.effect("attributes every operator and global rolling admission bound", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        const attemptedAt = DateTime.makeUnsafe("2026-08-01T12:45:00Z");
        const earlierAt = DateTime.subtract(attemptedAt, { minutes: 30 });
        const operatorId = SupportOperatorId.make({
          issuer: "https://test.cloudflareaccess.com",
          subject: "bounded-operator",
        });

        yield* sql`DELETE FROM support_recovery_admission_attempts`;
        yield* sql`
          INSERT INTO support_recovery_admission_attempts (
            operator_issuer, operator_subject, attempted_at, invocation_count
          ) VALUES (${operatorId.issuer}, ${operatorId.subject}, ${earlierAt}, 20)
        `;
        expect((yield* admitSupportRecoveryInvocation(operatorId, attemptedAt))._tag).toBe(
          "Limited"
        );

        yield* sql`DELETE FROM support_recovery_admission_attempts`;
        yield* sql`
          INSERT INTO support_recovery_admission_attempts (
            operator_issuer, operator_subject, attempted_at, invocation_count
          ) VALUES ('https://test.cloudflareaccess.com', 'minute-neighbor', ${attemptedAt}, 20)
        `;
        expect((yield* admitSupportRecoveryInvocation(operatorId, attemptedAt))._tag).toBe(
          "Limited"
        );

        yield* sql`DELETE FROM support_recovery_admission_attempts`;
        yield* sql`
          INSERT INTO support_recovery_admission_attempts (
            operator_issuer, operator_subject, attempted_at, invocation_count
          ) VALUES ('https://test.cloudflareaccess.com', 'hour-neighbor', ${earlierAt}, 100)
        `;
        expect((yield* admitSupportRecoveryInvocation(operatorId, attemptedAt))._tag).toBe(
          "Limited"
        );
      })
    );

    it.effect("rechecks pairing expiry at the BrowserLogin owner transition", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const pairing = yield* startPairing("owner-expiry-recheck");
        const attemptedAt = yield* DateTime.now;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_login_pairings
          SET expires_at = clock_timestamp() + interval '100 milliseconds'
          WHERE id = ${pairing.pairingId}
        `;
        yield* sql`SELECT pg_sleep(0.25)`;

        const approval = yield* withUserTransaction(
          userId,
          withSubjectLockInScope(
            userId,
            withUserLockInScope(
              advisoryLockKey.browserLoginApproval(userId),
              approveBrowserLoginPairingForExistingUserInScope({
                userId,
                pairingId: pairing.pairingId,
                attemptedAt,
              })
            )
          )
        );
        expect(Option.isNone(approval)).toBe(true);
        expect(
          yield* sql`
            SELECT lifecycle, user_id AS "userId"
            FROM browser_login_pairings WHERE id = ${pairing.pairingId}
          `
        ).toEqual([{ lifecycle: "expired", userId: null }]);
      })
    );

    it.effect("denies recovery storage across role and User-scope boundaries", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const pairing = yield* startPairing("rls-boundaries");
        expect((yield* support(pairing.publicCode, recoveryCode)).status).toBe(200);

        const migrationSql = yield* MigrationSqlClient;
        const runtimeSql = yield* SqlClient.SqlClient;
        const wrongRoleTableRead = yield* Effect.result(
          migrationSql.withTransaction(
            Effect.gen(function* () {
              yield* migrationSql`SET LOCAL ROLE pg_monitor`;
              return yield* migrationSql`SELECT id FROM support_recovery_cases`;
            })
          )
        );
        const wrongRoleGatewayCall = yield* Effect.result(
          migrationSql.withTransaction(
            Effect.gen(function* () {
              yield* migrationSql`SET LOCAL ROLE pg_monitor`;
              return yield* migrationSql`SELECT fidy_has_support_recovery_open_capacity()`;
            })
          )
        );
        expect(Result.isFailure(wrongRoleTableRead)).toBe(true);
        expect(Result.isFailure(wrongRoleGatewayCall)).toBe(true);

        expect(
          yield* runtimeSql`
            SELECT id FROM support_recovery_cases WHERE user_id = ${userId}
          `
        ).toEqual([]);
        expect(yield* runtimeSql`SELECT id FROM support_recovery_case_events`).toEqual([]);
        expect(
          Result.isFailure(
            yield* Effect.result(runtimeSql`SELECT fidy_delete_support_recovery_for_titular()`)
          )
        ).toBe(true);

        expect(
          yield* withUserTransaction(
            otherUserId,
            runtimeSql`SELECT id FROM support_recovery_cases WHERE user_id = ${userId}`
          )
        ).toEqual([]);
        expect(
          yield* withUserTransaction(
            otherUserId,
            runtimeSql`SELECT id FROM support_recovery_case_events`
          )
        ).toEqual([]);
        yield* withUserTransaction(otherUserId, deleteSupportRecoveryForTitular());
        const caseEvidence = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ id: SupportRecoveryCaseId, eventCount: Schema.Int }))
        )(
          yield* withUserTransaction(
            userId,
            runtimeSql`
              SELECT recovery_case.id, count(event.id)::int AS "eventCount"
              FROM support_recovery_cases recovery_case
              JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
              WHERE recovery_case.user_id = ${userId}
              GROUP BY recovery_case.id
            `
          )
        ).pipe(Effect.orDie);
        expect(caseEvidence).toHaveLength(1);
        expect(caseEvidence[0]?.eventCount).toBe(2);
      })
    );

    it.effect("expires an open case with append-only evidence at the pairing deadline", () =>
      Effect.gen(function* () {
        yield* prepare(expiringUserId, expiringRecoveryCode);
        const pairing = yield* startPairing("expiry");
        const sql = yield* MigrationSqlClient;
        const revisionRows = yield* sql`
          SELECT revision FROM backup_recovery_credentials WHERE user_id = ${expiringUserId}
        `;
        const revisionRow = revisionRows[0];
        assert.ok(revisionRow);
        const { revision } = revisionRow;
        assert.ok(typeof revision === "number");
        const crypto = yield* Crypto.Crypto;
        yield* withUserTransaction(
          expiringUserId,
          insertSupportRecoveryCase({
            id: SupportRecoveryCaseId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
            eventId: SupportRecoveryCaseEventId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
            userId: expiringUserId,
            pairingId: pairing.pairingId,
            credentialRevision: revision,
            operatorId: SupportOperatorId.make({
              issuer: "https://test.cloudflareaccess.com",
              subject: "expiry-test-operator",
            }),
            openedAt: DateTime.add(pairing.expiresAt, { minutes: -1 }),
            expiresAt: pairing.expiresAt,
          })
        );

        expect(yield* expireDueSupportRecoveryCases(pairing.expiresAt)).toBe(1n);
        expect((yield* support(pairing.publicCode, expiringRecoveryCode)).status).toBe(400);
        expect(
          yield* sql`
            SELECT recovery_case.lifecycle,
              array_agg(event.action || '/' || event.outcome ORDER BY event.ordinal) AS events
            FROM support_recovery_cases recovery_case
            JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
            WHERE recovery_case.user_id = ${expiringUserId}
            GROUP BY recovery_case.lifecycle
          `
        ).toEqual([{ lifecycle: "expired", events: ["open/accepted", "expire/expired"] }]);
        yield* sql`DELETE FROM support_recovery_cases WHERE user_id = ${expiringUserId}`;
        yield* sql`DELETE FROM browser_login_start_attempts`;
        yield* sql`DELETE FROM browser_login_pairings WHERE id = ${pairing.pairingId}`;
      })
    );

    it.effect(
      "refuses wrong and cross-User attempts without switching pairing or case ownership",
      () =>
        Effect.gen(function* () {
          yield* prepare(userId, recoveryCode);
          yield* installStableRecoveryFixture(otherUserId, otherRecoveryCode);
          const pairing = yield* startPairing("cross-user");
          expect((yield* support(pairing.publicCode, "wrong-recovery-code")).status).toBe(400);

          const sql = yield* MigrationSqlClient;
          const revisionRows = yield* sql`
            SELECT revision FROM backup_recovery_credentials WHERE user_id = ${userId}
          `;
          const revisionRow = revisionRows[0];
          assert.ok(revisionRow && typeof revisionRow.revision === "number");
          const crypto = yield* Crypto.Crypto;
          yield* withUserTransaction(
            userId,
            insertSupportRecoveryCase({
              id: SupportRecoveryCaseId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
              eventId: SupportRecoveryCaseEventId.make(
                yield* crypto.randomUUIDv7.pipe(Effect.orDie)
              ),
              userId,
              pairingId: pairing.pairingId,
              credentialRevision: revisionRow.revision,
              operatorId: SupportOperatorId.make({
                issuer: "https://test.cloudflareaccess.com",
                subject: "cross-user-test-operator",
              }),
              openedAt: DateTime.add(pairing.expiresAt, { minutes: -1 }),
              expiresAt: pairing.expiresAt,
            })
          );

          expect((yield* support(pairing.publicCode, otherRecoveryCode)).status).toBe(400);
          expect(
            yield* sql`
              SELECT recovery_case.user_id AS "userId", recovery_case.lifecycle,
                array_agg(event.action || '/' || event.outcome ORDER BY event.ordinal) AS events
              FROM support_recovery_cases recovery_case
              JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
              WHERE recovery_case.pairing_id = ${pairing.pairingId}
              GROUP BY recovery_case.user_id, recovery_case.lifecycle
            `
          ).toEqual([{ userId, lifecycle: "open", events: ["open/accepted", "decide/rejected"] }]);
          expect(
            yield* sql`
              SELECT lifecycle, user_id AS "userId" FROM browser_login_pairings
              WHERE id = ${pairing.pairingId}
            `
          ).toEqual([{ lifecycle: "pending_approval", userId: null }]);
        })
    );

    it.effect("allows one winner for duplicate invocation by two operators on one case", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const pairing = yield* startPairing("operator-race");
        const outcomes = yield* Effect.all(
          ["operator-a", "operator-b"].map((subject) =>
            approveSupportRecovery({
              operatorId: SupportOperatorId.make({
                issuer: "https://test.cloudflareaccess.com",
                subject,
              }),
              pairingCode: pairing.publicCode,
              backupRecoveryCode: Redacted.make(recoveryCode),
            })
          ),
          { concurrency: "unbounded" }
        );
        expect(outcomes.sort()).toEqual(["Approved", "NotApproved"]);
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
            SELECT lifecycle, count(*)::int AS count FROM browser_login_pairings
            WHERE id = ${pairing.pairingId} GROUP BY lifecycle
          `
        ).toEqual([{ lifecycle: "ready", count: 1 }]);
        expect(
          yield* sql`
            SELECT recovery_case.lifecycle,
              array_agg(event.action || '/' || event.outcome ORDER BY event.ordinal) AS events
            FROM support_recovery_cases recovery_case
            JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
            WHERE recovery_case.user_id = ${userId}
            GROUP BY recovery_case.lifecycle
          `
        ).toEqual([{ lifecycle: "approved", events: ["open/accepted", "approve/accepted"] }]);
      })
    );

    it.effect("allows one winner for the same code against two pairings", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const pairings = yield* Effect.all([
          startPairing("pairing-race-a"),
          startPairing("pairing-race-b"),
        ]);
        const outcomes = yield* Effect.all(
          pairings.map((pairing, index) =>
            approveSupportRecovery({
              operatorId: SupportOperatorId.make({
                issuer: "https://test.cloudflareaccess.com",
                subject: `pairing-operator-${index}`,
              }),
              pairingCode: pairing.publicCode,
              backupRecoveryCode: Redacted.make(recoveryCode),
            })
          ),
          { concurrency: "unbounded" }
        );
        expect(outcomes.sort()).toEqual(["Approved", "NotApproved"]);
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
            SELECT recovery_case.lifecycle,
              array_agg(event.action || '/' || event.outcome ORDER BY event.ordinal) AS events
            FROM support_recovery_cases recovery_case
            JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
            WHERE recovery_case.user_id = ${userId}
            GROUP BY recovery_case.lifecycle
          `
        ).toEqual([{ lifecycle: "approved", events: ["open/accepted", "approve/accepted"] }]);
        expect(
          yield* sql`
            SELECT lifecycle, count(*)::int AS count FROM browser_login_pairings
            WHERE id IN (${pairings[0].pairingId}, ${pairings[1].pairingId})
            GROUP BY lifecycle ORDER BY lifecycle
          `
        ).toEqual([
          { lifecycle: "pending_approval", count: 1 },
          { lifecycle: "ready", count: 1 },
        ]);
      })
    );

    it.effect("serializes support against the hosted WhatsApp BrowserLogin approval owner", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const pairing = yield* startPairing("hosted-owner-race");
        const [supportOutcome, hostedOutcome] = yield* Effect.all(
          [
            approveSupportRecovery({
              operatorId: SupportOperatorId.make({
                issuer: "https://test.cloudflareaccess.com",
                subject: "support-race-operator",
              }),
              pairingCode: pairing.publicCode,
              backupRecoveryCode: Redacted.make(recoveryCode),
            }).pipe(Effect.result),
            withUserTransaction(
              userId,
              approveBrowserLoginPairing({ userId, publicCode: pairing.publicCode })
            ).pipe(Effect.result),
          ],
          { concurrency: "unbounded" }
        );
        const supportApproved =
          Result.isSuccess(supportOutcome) && supportOutcome.success === "Approved";
        const hostedApproved = Result.isSuccess(hostedOutcome);
        expect(Number(supportApproved) + Number(hostedApproved)).toBe(1);
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
            SELECT lifecycle, user_id AS "userId" FROM browser_login_pairings
            WHERE id = ${pairing.pairingId}
          `
        ).toEqual([{ lifecycle: "ready", userId }]);
        expect(
          yield* sql`
            SELECT count(*)::int AS count FROM support_recovery_cases
            WHERE user_id = ${userId}
          `
        ).toEqual([{ count: supportApproved ? 1 : 0 }]);
      })
    );

    it.effect("serializes support against verified-email BrowserLogin approval", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const pairing = yield* startPairing("email-owner-race");
        const attemptedAt = yield* DateTime.now;
        const [supportOutcome, emailOutcome] = yield* Effect.all(
          [
            approveSupportRecovery({
              operatorId: SupportOperatorId.make({
                issuer: "https://test.cloudflareaccess.com",
                subject: "support-email-race",
              }),
              pairingCode: pairing.publicCode,
              backupRecoveryCode: Redacted.make(recoveryCode),
            }),
            withUserTransaction(
              userId,
              withSubjectLockInScope(
                userId,
                withUserLockInScope(
                  advisoryLockKey.browserLoginApproval(userId),
                  approveBrowserLoginPairingWithPrivateVerifierInScope({
                    pairingId: pairing.pairingId,
                    privateVerifier: Redacted.value(pairing.privateVerifier),
                    userId,
                    attemptedAt,
                  })
                )
              )
            ),
          ],
          { concurrency: "unbounded" }
        );
        expect(Number(supportOutcome === "Approved") + Number(emailOutcome)).toBe(1);
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
            SELECT count(*)::int AS count FROM support_recovery_cases
            WHERE user_id = ${userId}
          `
        ).toEqual([{ count: supportOutcome === "Approved" ? 1 : 0 }]);
        expect(
          yield* sql`
            SELECT lifecycle, user_id AS "userId" FROM browser_login_pairings
            WHERE id = ${pairing.pairingId}
          `
        ).toEqual([{ lifecycle: "ready", userId }]);
      })
    );

    it.effect(
      "keeps the legal approval-then-redemption sequence consistent under concurrency",
      () =>
        Effect.gen(function* () {
          yield* prepare(userId, recoveryCode);
          const pairing = yield* startPairing("redemption-race");
          const [approval, redemption] = yield* Effect.all(
            [support(pairing.publicCode, recoveryCode), redeem(pairing)],
            { concurrency: "unbounded" }
          );
          expect(approval.status).toBe(200);
          expect([200, 400, 429]).toContain(redemption.status);
          const sql = yield* MigrationSqlClient;
          const sessions = yield* sql`
            SELECT count(*)::int AS count FROM web_sessions WHERE user_id = ${userId}
          `;
          expect(sessions).toHaveLength(1);
          const sessionCount = sessions[0]?.count;
          assert.equal(typeof sessionCount, "number");
          expect([0, 1]).toContain(sessionCount);
          expect(
            yield* sql`
            SELECT lifecycle FROM browser_login_pairings WHERE id = ${pairing.pairingId}
          `
          ).toEqual([{ lifecycle: sessionCount === 1 ? "consumed" : "ready" }]);
        })
    );

    it.effect("gives one winner to eligible session rotation versus support approval", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const sessionPairing = yield* startPairing("eligible-rotation-session");
        yield* withUserTransaction(
          userId,
          approveBrowserLoginPairing({ userId, publicCode: sessionPairing.publicCode })
        );
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_login_pairings SET last_accepted_poll_at = now() - interval '5 seconds'
          WHERE id = ${sessionPairing.pairingId}
        `;
        const session = yield* redeem(sessionPairing);
        expect(session.status).toBe(200);
        const cookie = session.headers["set-cookie"]?.split(";")[0];
        assert.ok(cookie);
        const recoveryPairing = yield* startPairing("eligible-rotation-recovery");
        const [approval, rotation] = yield* Effect.all(
          [
            support(recoveryPairing.publicCode, recoveryCode),
            HttpClient.post("/recovery/backup-code/rotate", { headers: { cookie } }),
          ],
          { concurrency: "unbounded" }
        );
        expect([approval.status, rotation.status].filter((status) => status === 200)).toHaveLength(
          1
        );
        expect([200, 400]).toContain(approval.status);
        expect([200, 403]).toContain(rotation.status);
        expect(
          yield* sql`
            SELECT code_digest IS NULL AS consumed,
              (SELECT count(*)::int FROM support_recovery_cases
                WHERE user_id = ${userId} AND lifecycle = 'approved') AS approvals
            FROM backup_recovery_credentials WHERE user_id = ${userId}
          `
        ).toEqual([
          { consumed: approval.status === 200, approvals: approval.status === 200 ? 1 : 0 },
        ]);
      })
    );

    it.effect("closes exactly once when concurrent decisions reach the fifth rejection", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const pairing = yield* startPairing("fifth-rejection-race");
        const sql = yield* MigrationSqlClient;
        const caseId = SupportRecoveryCaseId.make("f1d1a000-0000-4000-8000-000000000b01");
        const openedAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
        yield* sql`
          INSERT INTO support_recovery_cases (
            id, user_id, pairing_id, credential_revision, lifecycle, opened_at, expires_at
          ) SELECT
            ${caseId}, ${userId}, ${pairing.pairingId}, credential.revision, 'open', ${openedAt},
            ${DateTime.add(openedAt, { minutes: 15 })}
          FROM backup_recovery_credentials credential WHERE credential.user_id = ${userId}
        `;
        for (const ordinal of [1, 2, 3, 4]) {
          yield* sql`
            INSERT INTO support_recovery_case_events (
              id, case_id, ordinal, operator_issuer, operator_subject,
              action, outcome, occurred_at
            ) VALUES (
              ${`f1d1a000-0000-4000-8000-000000000b${ordinal + 1}0`}, ${caseId}, ${ordinal},
              'https://test.cloudflareaccess.com', 'fixture-operator',
              ${ordinal === 1 ? "open" : "decide"},
              ${ordinal === 1 ? "accepted" : "rejected"}, ${openedAt}
            )
          `;
        }
        const decide = (
          subject: string,
          suffix: string
        ): Effect.Effect<boolean, never, SqlClient.SqlClient> =>
          withUserTransaction(
            userId,
            withSubjectLockInScope(
              userId,
              Effect.gen(function* () {
                const recoveryCase = yield* findOpenSupportRecoveryCase(userId);
                if (Option.isNone(recoveryCase)) return false;
                yield* rejectSupportRecoveryCase({
                  rejectionEventId: SupportRecoveryCaseEventId.make(
                    `f1d1a000-0000-4000-8000-000000000${suffix}1`
                  ),
                  refusalEventId: SupportRecoveryCaseEventId.make(
                    `f1d1a000-0000-4000-8000-000000000${suffix}2`
                  ),
                  recoveryCase: recoveryCase.value,
                  operatorId: SupportOperatorId.make({
                    issuer: "https://test.cloudflareaccess.com",
                    subject,
                  }),
                  rejectedAt: openedAt,
                });
                return true;
              })
            )
          );
        // Both attributable rejections are legal; only the transaction that reaches five closes.
        expect(
          yield* Effect.all([decide("operator-a", "0a"), decide("operator-b", "0b")], {
            concurrency: "unbounded",
          })
        ).toEqual([true, true]);
        expect(
          yield* sql`
            SELECT recovery_case.lifecycle,
              count(event.id) FILTER (WHERE event.action = 'decide')::int AS rejections,
              count(event.id) FILTER (WHERE event.action = 'close')::int AS closures
            FROM support_recovery_cases recovery_case
            JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
            WHERE recovery_case.id = ${caseId} GROUP BY recovery_case.lifecycle
          `
        ).toEqual([{ lifecycle: "refused", rejections: 5, closures: 1 }]);
      })
    );

    it.effect("rolls back every support approval owner write after injected failures", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        const cleanup = sql`
          DROP TRIGGER IF EXISTS recovery_fault_case ON support_recovery_cases;
          DROP TRIGGER IF EXISTS recovery_fault_open_event ON support_recovery_case_events;
          DROP TRIGGER IF EXISTS recovery_fault_pairing ON browser_login_pairings;
          DROP TRIGGER IF EXISTS recovery_fault_credential ON backup_recovery_credentials;
          DROP TRIGGER IF EXISTS recovery_fault_rotation ON backup_recovery_credentials;
          DROP TRIGGER IF EXISTS recovery_fault_event ON support_recovery_case_events;
          DROP TRIGGER IF EXISTS recovery_fault_closure ON support_recovery_cases;
          DROP FUNCTION IF EXISTS fidy_test_recovery_fault();
          DROP TABLE IF EXISTS support_recovery_fault_fixture
        `.pipe(Effect.orDie);
        yield* Effect.gen(function* () {
          yield* sql`
            CREATE TABLE support_recovery_fault_fixture (stage text PRIMARY KEY);
            CREATE FUNCTION fidy_test_recovery_fault() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS $function$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM public.support_recovery_fault_fixture
                WHERE stage = TG_ARGV[0]
              ) THEN
                RAISE EXCEPTION 'injected support recovery rollback';
              END IF;
              RETURN NEW;
            END
            $function$;
            CREATE TRIGGER recovery_fault_case
              AFTER INSERT ON support_recovery_cases FOR EACH ROW
              WHEN (NEW.lifecycle = 'open')
              EXECUTE FUNCTION fidy_test_recovery_fault('case');
            CREATE TRIGGER recovery_fault_open_event
              AFTER INSERT ON support_recovery_case_events FOR EACH ROW
              WHEN (NEW.action = 'open')
              EXECUTE FUNCTION fidy_test_recovery_fault('open-event');
            CREATE TRIGGER recovery_fault_pairing
              AFTER UPDATE ON browser_login_pairings FOR EACH ROW
              WHEN (OLD.lifecycle = 'pending_approval' AND NEW.lifecycle = 'ready')
              EXECUTE FUNCTION fidy_test_recovery_fault('pairing');
            CREATE TRIGGER recovery_fault_credential
              AFTER UPDATE ON backup_recovery_credentials FOR EACH ROW
              WHEN (OLD.code_digest IS NOT NULL AND NEW.code_digest IS NULL)
              EXECUTE FUNCTION fidy_test_recovery_fault('credential');
            CREATE TRIGGER recovery_fault_rotation
              AFTER UPDATE ON backup_recovery_credentials FOR EACH ROW
              WHEN (NEW.code_digest IS NOT NULL AND NEW.revision > OLD.revision)
              EXECUTE FUNCTION fidy_test_recovery_fault('rotation');
            CREATE TRIGGER recovery_fault_event
              AFTER INSERT ON support_recovery_case_events FOR EACH ROW
              WHEN (NEW.action = 'approve')
              EXECUTE FUNCTION fidy_test_recovery_fault('event');
            CREATE TRIGGER recovery_fault_closure
              AFTER UPDATE ON support_recovery_cases FOR EACH ROW
              WHEN (NEW.lifecycle = 'approved')
              EXECUTE FUNCTION fidy_test_recovery_fault('closure')
          `;
          for (const stage of ["case", "open-event", "pairing", "credential", "event", "closure"]) {
            yield* sql`DELETE FROM support_recovery_fault_fixture`;
            yield* prepare(userId, recoveryCode);
            const pairing = yield* startPairing(`rollback-${stage}`);
            yield* sql`INSERT INTO support_recovery_fault_fixture (stage) VALUES (${stage})`;
            const direct = yield* Effect.result(
              approveSupportRecovery({
                operatorId: SupportOperatorId.make({
                  issuer: "https://test.cloudflareaccess.com",
                  subject: "rollback-operator",
                }),
                pairingCode: pairing.publicCode,
                backupRecoveryCode: Redacted.make(recoveryCode),
              })
            );
            assert.ok(Result.isFailure(direct));
            expect(direct.failure).toBeInstanceOf(SupportRecoveryOperationalFailure);
            const response = yield* support(pairing.publicCode, recoveryCode);
            expect(response.status).toBe(503);
            yield* sql`DELETE FROM support_recovery_fault_fixture`;
            expect(
              yield* sql`
                SELECT pairing.lifecycle, pairing.user_id AS "userId",
                  credential.code_digest IS NOT NULL AS active,
                  (SELECT count(*)::int FROM support_recovery_cases
                    WHERE user_id = ${userId}) AS cases,
                  (SELECT count(*)::int FROM support_recovery_case_events) AS events
                FROM browser_login_pairings pairing
                JOIN backup_recovery_credentials credential ON credential.user_id = ${userId}
                WHERE pairing.id = ${pairing.pairingId}
              `
            ).toEqual([
              { lifecycle: "pending_approval", userId: null, active: true, cases: 0, events: 0 },
            ]);
          }

          yield* sql`DELETE FROM support_recovery_fault_fixture`;
          yield* prepare(userId, recoveryCode);
          const pairing = yield* startPairing("rollback-rotation");
          expect((yield* support(pairing.publicCode, recoveryCode)).status).toBe(200);
          yield* sql`
            UPDATE browser_login_pairings SET last_accepted_poll_at = now() - interval '5 seconds'
            WHERE id = ${pairing.pairingId}
          `;
          const redeemed = yield* redeem(pairing);
          const cookie = redeemed.headers["set-cookie"]?.split(";")[0];
          assert.ok(cookie);
          const credentialBefore = yield* sql`
            SELECT revision FROM backup_recovery_credentials WHERE user_id = ${userId}
          `;
          yield* sql`INSERT INTO support_recovery_fault_fixture (stage) VALUES ('rotation')`;
          const rotation = yield* HttpClient.post("/recovery/backup-code/rotate", {
            headers: { cookie },
          });
          expect([500, 503]).toContain(rotation.status);
          expect(yield* rotation.text).not.toContain("backupRecoveryCode");
          yield* sql`DELETE FROM support_recovery_fault_fixture`;
          expect(
            yield* sql`
              SELECT revision, code_digest IS NULL AS consumed
              FROM backup_recovery_credentials WHERE user_id = ${userId}
            `
          ).toEqual([{ revision: credentialBefore[0]?.revision, consumed: true }]);
        }).pipe(Effect.ensuring(cleanup));
      })
    );

    it.effect("approves recovery when financial-history reads are forbidden", () =>
      Effect.gen(function* () {
        yield* prepare(userId, recoveryCode);
        const sql = yield* MigrationSqlClient;
        yield* sql`
          INSERT INTO transactions (
            id, user_id, amount, currency, counterparty, direction, occurred_at, category_id
          ) VALUES (
            'f1d1a000-0000-4000-8000-000000000a34', ${userId}, 25000, 'COP',
            'Historial no probatorio', 'outflow', '2026-07-20T12:30:00Z',
            '10000000-0000-4000-8000-000000000016'
          )
        `;
        const pairing = yield* startPairing("financial-history-independent");
        yield* sql`REVOKE SELECT ON transactions FROM fidy_runtime, fidy_gateway`;
        const approval = yield* approveSupportRecovery({
          operatorId: SupportOperatorId.make({
            issuer: "https://test.cloudflareaccess.com",
            subject: "financial-history-test-operator",
          }),
          pairingCode: pairing.publicCode,
          backupRecoveryCode: Redacted.make(recoveryCode),
        }).pipe(
          Effect.ensuring(sql`GRANT SELECT ON transactions TO fidy_runtime`.pipe(Effect.orDie))
        );
        expect(approval).toBe("Approved");
        expect(
          yield* sql`
            SELECT count(*)::int AS count FROM transactions
            WHERE id = 'f1d1a000-0000-4000-8000-000000000a34'
          `
        ).toEqual([{ count: 1 }]);
      })
    );

    it.effect(
      "consumes one code and gives approval one winner against concurrent session rotation",
      () =>
        Effect.gen(function* () {
          yield* prepare(userId, recoveryCode);
          const sql = yield* MigrationSqlClient;
          const identityBefore = yield* sql`
            SELECT email.user_id AS "emailUserId", email.email_address AS "emailAddress",
              email.verified_at AS "emailVerifiedAt", whatsapp.user_id AS "whatsappUserId",
              whatsapp.phone_number AS "phoneNumber", whatsapp.verified_at AS "whatsappVerifiedAt"
            FROM verified_email_credentials email
            JOIN whatsapp_identities whatsapp ON whatsapp.user_id = email.user_id
            WHERE email.user_id = ${userId}
          `;
          const pairing = yield* startPairing("approval");
          const untouchedPairing = yield* startPairing("cross-pairing");
          const duplicateResponses = yield* Effect.all(
            [support(pairing.publicCode, recoveryCode), support(pairing.publicCode, recoveryCode)],
            { concurrency: "unbounded" }
          );
          expect(
            duplicateResponses.map(({ status }) => status).sort((left, right) => left - right)
          ).toEqual([200, 400]);
          const duplicateBodies = yield* Effect.forEach(
            duplicateResponses,
            (response) => response.json
          );
          expect(
            duplicateBodies.filter((_, index) => duplicateResponses[index]?.status === 400)
          ).toEqual([
            {
              status: "not_approved",
              message:
                "No pudimos aprobar la recuperación. La información proporcionada o la vinculación no permiten continuar. Si aún conservas tu código de recuperación, inicia una nueva vinculación y vuelve a contactar a soporte. No envíes documentos, datos financieros ni números de tarjeta o cuenta.",
            },
          ]);
          const approved = duplicateResponses.find(({ status }) => status === 200);
          assert.ok(approved);
          expect(approved.headers["cache-control"]).toBe("no-store");

          expect(
            yield* sql`
            SELECT pairing.lifecycle, pairing.user_id AS "userId",
              credential.code_digest IS NULL AS consumed,
              recovery_case.lifecycle AS "caseLifecycle",
              array_agg(event.action || '/' || event.outcome ORDER BY event.ordinal) AS events
            FROM browser_login_pairings pairing
            JOIN support_recovery_cases recovery_case ON recovery_case.pairing_id = pairing.id
            JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
            JOIN backup_recovery_credentials credential ON credential.user_id = pairing.user_id
            WHERE pairing.id = ${pairing.pairingId}
            GROUP BY pairing.lifecycle, pairing.user_id, credential.code_digest,
              recovery_case.lifecycle
          `
          ).toEqual([
            {
              lifecycle: "ready",
              userId,
              consumed: true,
              caseLifecycle: "approved",
              events: ["open/accepted", "approve/accepted"],
            },
          ]);
          expect(yield* sql`SELECT count(*)::int AS count FROM web_sessions`).toEqual([
            { count: 0 },
          ]);
          expect(
            yield* sql`
              SELECT lifecycle, user_id AS "userId" FROM browser_login_pairings
              WHERE id = ${untouchedPairing.pairingId}
            `
          ).toEqual([{ lifecycle: "pending_approval", userId: null }]);

          yield* sql`
          UPDATE browser_login_pairings SET last_accepted_poll_at = now() - interval '5 seconds'
          WHERE id = ${pairing.pairingId}
        `;
          const redeemed = yield* redeem(pairing);
          expect(redeemed.status).toBe(200);
          const cookie = redeemed.headers["set-cookie"]?.split(";")[0];
          assert.ok(cookie);

          const beforeStaleRotation = yield* sql`
            SELECT revision, encode(code_digest, 'hex') AS digest,
              last_rotated_by_web_session_id AS "lastRotatedByWebSessionId",
              (SELECT count(*)::int FROM audit_log_entries
                WHERE user_id = ${userId}
                  AND operation = 'recovery.rotateBackupRecoveryCode'
                  AND outcome = 'succeeded') AS "successfulAudits"
            FROM backup_recovery_credentials WHERE user_id = ${userId}
          `;
          yield* sql`
            UPDATE web_sessions SET paired_at = now() - interval '11 minutes',
              fresh_until = now() - interval '1 minute',
              hard_expires_at = now() - interval '11 minutes' + interval '90 days'
            WHERE user_id = ${userId}
          `;
          const staleRotation = yield* HttpClient.post("/recovery/backup-code/rotate", {
            headers: { cookie },
          });
          expect(staleRotation.status).toBe(401);
          expect(yield* staleRotation.text).not.toContain("backupRecoveryCode");
          expect(
            yield* sql`
              SELECT revision, encode(code_digest, 'hex') AS digest,
                last_rotated_by_web_session_id AS "lastRotatedByWebSessionId",
                (SELECT count(*)::int FROM audit_log_entries
                  WHERE user_id = ${userId}
                    AND operation = 'recovery.rotateBackupRecoveryCode'
                    AND outcome = 'succeeded') AS "successfulAudits"
              FROM backup_recovery_credentials WHERE user_id = ${userId}
            `
          ).toEqual(beforeStaleRotation);
          yield* sql`
            UPDATE web_sessions SET paired_at = now(),
              fresh_until = now() + interval '10 minutes',
              hard_expires_at = now() + interval '90 days'
            WHERE user_id = ${userId}
          `;

          const rotationResponses = yield* Effect.all(
            Array.from({ length: 10 }, () =>
              HttpClient.post("/recovery/backup-code/rotate", { headers: { cookie } })
            ),
            { concurrency: "unbounded" }
          );
          expect(rotationResponses.filter(({ status }) => status === 200)).toHaveLength(1);
          expect(rotationResponses.filter(({ status }) => status === 403)).toHaveLength(9);
          const rotated = rotationResponses.find(({ status }) => status === 200);
          assert.ok(rotated);
          expect(rotated.headers["cache-control"]).toBe("no-store");
          const body = yield* rotated.json;
          const decodedRotation = yield* Schema.decodeUnknownEffect(
            Schema.toCodecJson(Schema.Struct({ data: RotatedBackupRecoveryCode }))
          )(body);
          const replacement = Redacted.value(decodedRotation.data.backupRecoveryCode);
          expect(replacement).not.toBe(recoveryCode);
          expect(
            yield* sql`
              SELECT operation, outcome FROM audit_log_entries
              WHERE user_id = ${userId} AND operation = 'recovery.rotateBackupRecoveryCode'
                AND outcome = 'succeeded'
            `
          ).toEqual([{ operation: "recovery.rotateBackupRecoveryCode", outcome: "succeeded" }]);

          const secondPairing = yield* startPairing("replacement-approval");
          expect((yield* support(secondPairing.publicCode, recoveryCode)).status).toBe(400);
          const [replacementApproval, losingRotation] = yield* Effect.all(
            [
              support(secondPairing.publicCode, replacement),
              HttpClient.post("/recovery/backup-code/rotate", { headers: { cookie } }),
            ],
            { concurrency: "unbounded" }
          );
          expect(replacementApproval.status).toBe(200);
          expect(losingRotation.status).toBe(403);
          expect(yield* sql`SELECT count(*)::int AS count FROM users WHERE id = ${userId}`).toEqual(
            [{ count: 1 }]
          );
          expect(
            yield* sql`
              SELECT email.user_id AS "emailUserId", email.email_address AS "emailAddress",
                email.verified_at AS "emailVerifiedAt", whatsapp.user_id AS "whatsappUserId",
                whatsapp.phone_number AS "phoneNumber", whatsapp.verified_at AS "whatsappVerifiedAt"
              FROM verified_email_credentials email
              JOIN whatsapp_identities whatsapp ON whatsapp.user_id = email.user_id
              WHERE email.user_id = ${userId}
            `
          ).toEqual(identityBefore);

          const closedRows = yield* sql`
            SELECT max(closed_at) AS "closedAt" FROM support_recovery_cases
            WHERE user_id = ${userId}
          `;
          const closedRow = closedRows[0];
          assert.ok(closedRow);
          const { closedAt } = closedRow;
          assert.ok(closedAt instanceof Date);
          const retentionBoundary = DateTime.add(DateTime.makeUnsafe(closedAt.toISOString()), {
            months: 24,
          });
          expect(yield* deleteExpiredSupportRecoveryEvidence(retentionBoundary)).toBe(2n);
          expect(
            yield* sql`
              SELECT consumed_at IS NOT NULL AS consumed,
                consumed_by_case_id IS NULL AS "caseReferenceDeleted"
              FROM backup_recovery_credentials WHERE user_id = ${userId}
            `
          ).toEqual([{ consumed: true, caseReferenceDeleted: true }]);

          const crypto = yield* Crypto.Crypto;
          const restoredDigest = yield* crypto
            .digest("SHA-256", new TextEncoder().encode(replacement))
            .pipe(Effect.orDie);
          const deletionObservation = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT set_config('fidy.user_id', ${userId}, true)`;
              yield* sql`SELECT fidy_delete_support_recovery_for_titular()`;
              const observed = yield* sql`
                SELECT count(*)::int AS count FROM backup_recovery_credentials
                WHERE user_id = ${userId}
              `;
              yield* sql`
                INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at)
                VALUES (${userId}, ${restoredDigest}, now())
              `;
              return observed;
            })
          );
          expect(deletionObservation).toEqual([{ count: 0 }]);
        })
    );
  }
);

layer(RealAccessRecoveryHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "support recovery Access boundary",
  (it) => {
    it.effect("rejects forged assertions before any recovery state or admission side effect", () =>
      Effect.gen(function* () {
        const { privateKey } = yield* RealAccessTestSigningKey;
        const unsigned = (input: {
          readonly issuer: string;
          readonly audience: string;
          readonly subject: string;
        }): SignJWT =>
          new SignJWT({})
            .setProtectedHeader({ alg: "RS256", kid: "support-key" })
            .setIssuer(input.issuer)
            .setAudience(input.audience)
            .setSubject(input.subject)
            .setIssuedAt();
        const sign = (input: {
          readonly issuer: string;
          readonly audience: string;
          readonly subject: string;
          readonly expiration: string;
        }): Effect.Effect<string> =>
          Effect.promise(() =>
            unsigned(input).setExpirationTime(input.expiration).sign(privateKey)
          );
        const signWithoutExpiration = (input: {
          readonly issuer: string;
          readonly audience: string;
          readonly subject: string;
        }): Effect.Effect<string> => Effect.promise(() => unsigned(input).sign(privateKey));
        const signWithoutIssuedAt = (input: {
          readonly issuer: string;
          readonly audience: string;
          readonly subject: string;
        }): Effect.Effect<string> =>
          Effect.promise(() =>
            new SignJWT({})
              .setProtectedHeader({ alg: "RS256", kid: "support-key" })
              .setIssuer(input.issuer)
              .setAudience(input.audience)
              .setSubject(input.subject)
              .setExpirationTime("15m")
              .sign(privateKey)
          );
        const valid = yield* sign({
          issuer: realAccessIssuer,
          audience: realAccessAudience,
          subject: "operator-42",
          expiration: "15m",
        });
        const tokenParts = valid.split(".");
        const signature = tokenParts[2];
        assert.ok(tokenParts.length === 3 && signature);
        const tampered = `${tokenParts[0]}.${tokenParts[1]}.${
          signature.startsWith("A") ? "B" : "A"
        }${signature.slice(1)}`;
        const invalidAssertions = [
          tampered,
          yield* sign({
            issuer: "https://other.cloudflareaccess.com",
            audience: realAccessAudience,
            subject: "operator-42",
            expiration: "15m",
          }),
          yield* sign({
            issuer: realAccessIssuer,
            audience: "wrong-audience",
            subject: "operator-42",
            expiration: "15m",
          }),
          yield* sign({
            issuer: realAccessIssuer,
            audience: realAccessAudience,
            subject: "operator-42",
            expiration: "16m",
          }),
          yield* sign({
            issuer: realAccessIssuer,
            audience: realAccessAudience,
            subject: "operator-42",
            expiration: "0s",
          }),
          yield* signWithoutExpiration({
            issuer: realAccessIssuer,
            audience: realAccessAudience,
            subject: "operator-42",
          }),
          yield* signFutureAccessAssertion(privateKey),
          yield* signWithoutIssuedAt({
            issuer: realAccessIssuer,
            audience: realAccessAudience,
            subject: "operator-42",
          }),
        ];
        const sql = yield* MigrationSqlClient;
        const before = yield* sql`
          SELECT
            (SELECT count(*)::int FROM support_recovery_admission_attempts) AS admissions,
            (SELECT count(*)::int FROM support_recovery_cases) AS cases,
            (SELECT count(*)::int FROM web_sessions) AS sessions,
            (SELECT count(*)::int FROM backup_recovery_credentials
              WHERE consumed_at IS NOT NULL) AS consumed
        `;
        for (const assertion of invalidAssertions) {
          const response = yield* HttpClient.post("/internal/support-recovery", {
            headers: { "cf-access-jwt-assertion": assertion },
            body: HttpBody.jsonUnsafe({
              pairingCode: "ABCDEFGH",
              backupRecoveryCode: recoveryCode,
            }),
          });
          expect(response.status).toBe(401);
        }
        expect(
          yield* sql`
            SELECT
              (SELECT count(*)::int FROM support_recovery_admission_attempts) AS admissions,
              (SELECT count(*)::int FROM support_recovery_cases) AS cases,
              (SELECT count(*)::int FROM web_sessions) AS sessions,
              (SELECT count(*)::int FROM backup_recovery_credentials
                WHERE consumed_at IS NOT NULL) AS consumed
          `
        ).toEqual(before);
      })
    );
  }
);
