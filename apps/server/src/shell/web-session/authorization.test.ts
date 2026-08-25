import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Effect, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { SqlSchema } from "effect/unstable/sql";
import { MigrationSqlClient } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { WebSessionId } from "~/core/web-session/reference";
import {
  calculateWebSessionDeadlines,
  webSessionIdleRenewalCandidate,
} from "~/core/web-session/rules";
import { truncateAuditLogEntries } from "~/shell/audit/fixtures";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { ApiHarness } from "~/shell/testing/api-harness";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000241");
const patBearer = TokenBearer.make("fin_websess1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000246");
const otherPatBearer = TokenBearer.make("fin_webother_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const webSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000242");
const webSessionBearer = "w".repeat(43);
const sessionCookieName = "__Host-fidy_session";

const seedActiveWebSession = Effect.gen(function* () {
  yield* truncateAuditLogEntries;
  const { user } = yield* seedConsentedPatIdentity({ userId, bearer: patBearer });
  const crypto = yield* Crypto.Crypto;
  const sql = yield* MigrationSqlClient;
  const bearerDigest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(webSessionBearer))
    .pipe(Effect.orDie);
  const pairedAt = yield* DateTime.now;
  const deadlines = calculateWebSessionDeadlines(pairedAt);
  yield* sql`DELETE FROM web_sessions WHERE user_id = ${userId}`;
  yield* sql`
    INSERT INTO web_sessions (
      id, user_id, bearer_digest, paired_at, fresh_until, idle_expires_at, hard_expires_at
    ) VALUES (
      ${webSessionId}, ${userId}, ${bearerDigest}, ${pairedAt}, ${deadlines.freshUntil},
      ${deadlines.idleExpiresAt}, ${deadlines.hardExpiresAt}
    )
  `;
  return user;
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "WebSession canonical authorization",
  (it) => {
    it.effect("resolves the cookie to the persisted User and records WebSession evidence", () =>
      Effect.gen(function* () {
        const expectedUser = yield* seedActiveWebSession;

        const response = yield* HttpClient.get("/user", {
          headers: { cookie: `${sessionCookieName}=${webSessionBearer}` },
        });
        const body = yield* response.json;
        const auditEntries = yield* observeAuditLogEntries(userId);

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          data: {
            id: expectedUser.id,
            locale: expectedUser.locale,
            timeZone: expectedUser.timeZone,
          },
          next: [],
        });
        expect(response.headers["set-cookie"]).toContain(`${sessionCookieName}=`);
        expect(response.headers["set-cookie"]).toContain("HttpOnly");
        expect(response.headers["set-cookie"]).toContain("Secure");
        expect(auditEntries).toHaveLength(1);
        expect(auditEntries[0]).toMatchObject({
          subjectUserId: userId,
          caller: { _tag: "WebSession", webSessionId },
          operation: "identity.getCurrentUser",
          outcome: "succeeded",
        });
      })
    );

    it.effect("keeps a WebSession inside its persisted User's RLS scope", () =>
      Effect.gen(function* () {
        yield* seedActiveWebSession;
        yield* seedConsentedPatIdentity({ userId: otherUserId, bearer: otherPatBearer });
        const sql = yield* MigrationSqlClient;
        const now = yield* DateTime.now;
        yield* sql`DELETE FROM memories WHERE user_id IN (${userId}, ${otherUserId})`;
        yield* sql`
          INSERT INTO memories (id, user_id, text, created_at, updated_at)
          VALUES (
            'f1d1a000-0000-7000-8000-000000000247', ${otherUserId},
            'belongs only to the other User', ${now}, ${now}
          )
        `;

        const response = yield* HttpClient.get("/memories", {
          headers: { cookie: `${sessionCookieName}=${webSessionBearer}` },
        });
        const body = yield* response.json;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ data: [] });
      })
    );

    it.effect("supplies the sealed read, write, and dashboard first-party capabilities", () =>
      Effect.gen(function* () {
        yield* seedActiveWebSession;
        const headers = {
          cookie: `${sessionCookieName}=${webSessionBearer}`,
          "content-type": "application/json",
        };

        const read = yield* HttpClient.get("/dashboard", { headers });
        const write = yield* HttpClient.patch("/user/preferences", {
          headers,
          body: HttpBody.jsonUnsafe({ locale: "es-CO", timeZone: "America/Bogota" }),
        });
        const dashboard = yield* HttpClient.post("/dashboard/edits", {
          headers,
          body: HttpBody.jsonUnsafe({ op: "set-title", title: "Mi tablero" }),
        });

        expect([read.status, write.status, dashboard.status]).toEqual([200, 200, 200]);
      })
    );

    it.effect("cannot use a WebSession to approve browser pairing", () =>
      Effect.gen(function* () {
        yield* seedActiveWebSession;
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM browser_login_pairings`;
        const startedResponse = yield* HttpClient.post("/web/pairings");
        const started = yield* Schema.decodeUnknownEffect(StartedBrowserLoginPairing)(
          yield* startedResponse.json
        );

        const approvalResponse = yield* HttpClient.post("/browser-login/pairings/approve", {
          headers: {
            cookie: `${sessionCookieName}=${webSessionBearer}`,
            "content-type": "application/json",
          },
          body: HttpBody.jsonUnsafe({ publicCode: started.publicCode }),
        });
        const pairing = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({
            lifecycle: Schema.String,
            hasNoUser: Schema.Boolean,
          }),
          execute: () => sql`
            SELECT lifecycle, (user_id IS NULL) AS "hasNoUser"
            FROM browser_login_pairings WHERE id = ${started.pairingId}
          `,
        })(undefined);
        const auditEntries = yield* observeAuditLogEntries(userId);

        expect(approvalResponse.status).toBe(403);
        expect(pairing).toEqual({ lifecycle: "pending_approval", hasNoUser: true });
        expect(auditEntries).toHaveLength(1);
        expect(auditEntries[0]).toMatchObject({
          caller: { _tag: "WebSession", webSessionId },
          operation: "browserLogin.approvePairing",
          outcome: "rejected",
        });
      })
    );

    it.effect(
      "rejects unknown, revoked, idle-expired, and hard-expired cookies before execution",
      () =>
        Effect.gen(function* () {
          yield* truncateAuditLogEntries;
          yield* seedConsentedPatIdentity({ userId, bearer: patBearer });
          const now = yield* DateTime.now;
          const sql = yield* MigrationSqlClient;
          const crypto = yield* Crypto.Crypto;
          const rejectedBearers = ["u", "r", "i", "h"].map((value) => value.repeat(43));
          const digests = yield* Effect.forEach(rejectedBearers, (bearer) =>
            crypto.digest("SHA-256", new TextEncoder().encode(bearer)).pipe(Effect.orDie)
          );
          const currentPairedAt = DateTime.subtractDuration(now, "1 day");
          const idleExpiredPairedAt = DateTime.subtractDuration(now, "40 days");
          const hardExpiredPairedAt = DateTime.subtractDuration(now, "91 days");
          yield* sql`DELETE FROM web_sessions WHERE user_id = ${userId}`;
          yield* sql`
          INSERT INTO web_sessions (
            id, user_id, bearer_digest, paired_at, fresh_until,
            idle_expires_at, hard_expires_at, revoked_at
          ) VALUES
          (
            'f1d1a000-0000-4000-8000-000000000243', ${userId}, ${digests[1]},
            ${currentPairedAt}, ${DateTime.addDuration(currentPairedAt, "10 minutes")},
            ${DateTime.addDuration(currentPairedAt, "30 days")},
            ${DateTime.addDuration(currentPairedAt, "90 days")}, ${now}
          ),
          (
            'f1d1a000-0000-4000-8000-000000000244', ${userId}, ${digests[2]},
            ${idleExpiredPairedAt}, ${DateTime.addDuration(idleExpiredPairedAt, "10 minutes")},
            ${DateTime.subtractDuration(now, "1 day")},
            ${DateTime.addDuration(idleExpiredPairedAt, "90 days")}, NULL
          ),
          (
            'f1d1a000-0000-4000-8000-000000000245', ${userId}, ${digests[3]},
            ${hardExpiredPairedAt}, ${DateTime.addDuration(hardExpiredPairedAt, "10 minutes")},
            ${DateTime.addDuration(hardExpiredPairedAt, "90 days")},
            ${DateTime.addDuration(hardExpiredPairedAt, "90 days")}, NULL
          )
        `;

          const responses = yield* Effect.forEach(rejectedBearers, (bearer) =>
            HttpClient.get("/user", {
              headers: { cookie: `${sessionCookieName}=${bearer}` },
            })
          );
          const auditEntries = yield* observeAuditLogEntries(userId);

          expect(responses.map(({ status }) => status)).toEqual([401, 401, 401, 401]);
          expect(
            responses.every(({ headers }) => headers["set-cookie"]?.includes("Max-Age=0"))
          ).toBe(true);
          expect(auditEntries).toEqual([]);
          expect(
            yield* sql`
            SELECT count(*)::int AS count
              FROM web_sessions
              WHERE user_id = ${userId} AND last_used_at IS NOT NULL
          `
          ).toEqual([{ count: 0 }]);
        })
    );

    it.effect("rolls durable renewal back when Consent rejects the request", () =>
      Effect.gen(function* () {
        yield* seedActiveWebSession;
        const sql = yield* MigrationSqlClient;
        const SessionUseState = Schema.Struct({
          lastUsedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
          idleExpiresAt: Schema.DateTimeUtcFromDate,
        });
        const readUseState = SqlSchema.findOne({
          Request: Schema.Void,
          Result: SessionUseState,
          execute: () => sql`
            SELECT last_used_at AS "lastUsedAt", idle_expires_at AS "idleExpiresAt"
            FROM web_sessions WHERE id = ${webSessionId}
          `,
        });
        const before = yield* readUseState(undefined);
        yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${userId}`;

        const response = yield* HttpClient.get("/user", {
          headers: { cookie: `${sessionCookieName}=${webSessionBearer}` },
        });
        const after = yield* readUseState(undefined);
        const auditEntries = yield* observeAuditLogEntries(userId);

        expect(response.status).toBe(403);
        expect(after).toEqual(before);
        expect(auditEntries).toHaveLength(1);
        expect(auditEntries[0]).toMatchObject({
          caller: { _tag: "WebSession", webSessionId },
          operation: "identity.getCurrentUser",
          outcome: "rejected",
        });
      })
    );

    it.effect("extends ordinary renewal monotonically in PostgreSQL", () =>
      Effect.gen(function* () {
        yield* seedConsentedPatIdentity({ userId, bearer: patBearer });
        const usedAt = yield* DateTime.now;
        const pairedAt = DateTime.subtractDuration(usedAt, "20 days");
        const initialIdleExpiresAt = DateTime.addDuration(usedAt, "1 day");
        const hardExpiresAt = DateTime.addDuration(pairedAt, "90 days");
        const bearer = "m".repeat(43);
        const bearerDigest = yield* (yield* Crypto.Crypto)
          .digest("SHA-256", new TextEncoder().encode(bearer))
          .pipe(Effect.orDie);
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM web_sessions WHERE user_id = ${userId}`;
        yield* sql`
          INSERT INTO web_sessions (
            id, user_id, bearer_digest, paired_at, fresh_until,
            idle_expires_at, hard_expires_at
          ) VALUES (
            ${webSessionId}, ${userId}, ${bearerDigest}, ${pairedAt},
            ${DateTime.addDuration(pairedAt, "10 minutes")},
            ${initialIdleExpiresAt}, ${hardExpiresAt}
          )
        `;

        const response = yield* HttpClient.get("/user", {
          headers: { cookie: `${sessionCookieName}=${bearer}` },
        });
        const readUseState = SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({
            lastUsedAt: Schema.DateTimeUtcFromDate,
            idleExpiresAt: Schema.DateTimeUtcFromDate,
          }),
          execute: () => sql`
            SELECT last_used_at AS "lastUsedAt", idle_expires_at AS "idleExpiresAt"
            FROM web_sessions WHERE id = ${webSessionId}
          `,
        });
        const renewed = yield* readUseState(undefined);
        const olderUsedAt = DateTime.addDuration(pairedAt, "5 days");
        yield* sql`SELECT * FROM fidy_use_web_session(
          ${bearerDigest}, ${olderUsedAt}, ${webSessionIdleRenewalCandidate(olderUsedAt)}
        )`;
        const afterOlderUse = yield* readUseState(undefined);
        const renewedForMilliseconds =
          DateTime.toEpochMillis(renewed.idleExpiresAt) - DateTime.toEpochMillis(usedAt);

        expect(response.status).toBe(200);
        expect(renewedForMilliseconds).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
        expect(renewedForMilliseconds).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 5_000);
        expect(afterOlderUse).toEqual(renewed);
      })
    );

    it.effect("caps durable and cookie idle renewal at immutable hard expiry", () =>
      Effect.gen(function* () {
        yield* seedConsentedPatIdentity({ userId, bearer: patBearer });
        const usedAt = yield* DateTime.now;
        const pairedAt = DateTime.subtractDuration(usedAt, "89 days");
        const hardExpiresAt = DateTime.addDuration(pairedAt, "90 days");
        const bearer = "b".repeat(43);
        const bearerDigest = yield* (yield* Crypto.Crypto)
          .digest("SHA-256", new TextEncoder().encode(bearer))
          .pipe(Effect.orDie);
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM web_sessions WHERE user_id = ${userId}`;
        yield* sql`
          INSERT INTO web_sessions (
            id, user_id, bearer_digest, paired_at, fresh_until,
            idle_expires_at, hard_expires_at
          ) VALUES (
            ${webSessionId}, ${userId}, ${bearerDigest}, ${pairedAt},
            ${DateTime.addDuration(pairedAt, "10 minutes")},
            ${DateTime.addDuration(usedAt, "1 hour")}, ${hardExpiresAt}
          )
        `;

        const response = yield* HttpClient.get("/user", {
          headers: { cookie: `${sessionCookieName}=${bearer}` },
        });
        const renewed = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({
            idleExpiresAt: Schema.DateTimeUtcFromDate,
            hardExpiresAt: Schema.DateTimeUtcFromDate,
          }),
          execute: () => sql`
            SELECT idle_expires_at AS "idleExpiresAt", hard_expires_at AS "hardExpiresAt"
            FROM web_sessions WHERE id = ${webSessionId}
          `,
        })(undefined);
        const maxAge = Number(/Max-Age=(\d+)/u.exec(response.headers["set-cookie"] ?? "")?.[1]);

        expect(response.status).toBe(200);
        expect(renewed.idleExpiresAt).toEqual(renewed.hardExpiresAt);
        expect(maxAge).toBeGreaterThan(0);
        expect(maxAge).toBeLessThanOrEqual(24 * 60 * 60);
      })
    );
  }
);
