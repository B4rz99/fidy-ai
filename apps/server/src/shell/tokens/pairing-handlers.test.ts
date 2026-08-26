import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Deferred, Effect, Fiber, Redacted, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { ClaimedPATPairing, PATPairingReview, StartedPATPairing } from "~/core/tokens/pairing";
import { TokenBearer } from "~/core/tokens/model";
import { WebSessionId } from "~/core/web-session/reference";
import { calculateWebSessionDeadlines } from "~/core/web-session/rules";
import { OperationResponse } from "~/shell/_shared/response";
import { MigrationSqlClient } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { ApiHarness, headersFor } from "~/shell/testing/api-harness";
import { claimPATPairing, expireDuePATPairings } from "./pat-pairing";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000349");
const seedBearer = TokenBearer.make("fin_patpair1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const webSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000350");
const webSessionBearer = "r".repeat(43);
const secondUserId = UserId.make("f1d1a000-0000-4000-8000-000000000351");
const secondSeedBearer = TokenBearer.make("fin_patpair2_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const secondWebSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000352");
const secondWebSessionBearer = "t".repeat(43);
const sessionCookieName = "__Host-fidy_session";
const testSourceAddress = "203.0.113.10";
const secondTestSourceAddress = "203.0.113.11";
const jsonHeaders = {
  "content-type": "application/json",
  "x-forwarded-for": testSourceAddress,
} as const;

const seedFreshWebSessionFor = Effect.fn("test.seedFreshWebSession")(function* (input: {
  readonly subjectUserId: UserId;
  readonly patBearer: TokenBearer;
  readonly sessionId: WebSessionId;
  readonly sessionBearer: string;
}) {
  yield* seedConsentedPatIdentity({ userId: input.subjectUserId, bearer: input.patBearer });
  const now = yield* DateTime.now;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* MigrationSqlClient;
  const bearerDigest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(input.sessionBearer))
    .pipe(Effect.orDie);
  const deadlines = calculateWebSessionDeadlines(now);
  yield* sql`DELETE FROM pat_pairing_start_attempts`;
  yield* sql`DELETE FROM pat_pairing_claim_attempts`;
  yield* sql`DELETE FROM pat_pairing_inspection_attempts
    WHERE user_id = ${input.subjectUserId}`;
  yield* sql`DELETE FROM consent_records
    WHERE subject_user_id = ${input.subjectUserId}
      AND decision_origin <> 'provider-qualified-messages'`;
  yield* sql`DELETE FROM web_sessions WHERE user_id = ${input.subjectUserId}`;
  yield* sql`DELETE FROM tokens
    WHERE user_id = ${input.subjectUserId} AND pat_pairing_id IS NOT NULL`;
  yield* sql`DELETE FROM pat_pairings WHERE user_id = ${input.subjectUserId}`;
  yield* sql`
    INSERT INTO web_sessions (
      id, user_id, bearer_digest, paired_at, fresh_until, idle_expires_at, hard_expires_at
    ) VALUES (
      ${input.sessionId}, ${input.subjectUserId}, ${bearerDigest}, ${now},
      ${deadlines.freshUntil}, ${deadlines.idleExpiresAt}, ${deadlines.hardExpiresAt}
    )
  `;
});

const seedFreshWebSession = seedFreshWebSessionFor({
  subjectUserId: userId,
  patBearer: seedBearer,
  sessionId: webSessionId,
  sessionBearer: webSessionBearer,
});

const postJsonFrom = Effect.fn("test.postPATPairingJsonFrom")(function* (
  path: string,
  body: unknown,
  sourceAddress: string
) {
  return yield* HttpClient.post(path, {
    headers: { ...jsonHeaders, "x-forwarded-for": sourceAddress },
    body: HttpBody.jsonUnsafe(body),
  });
});

const postJson = (path: string, body: unknown): ReturnType<typeof postJsonFrom> =>
  postJsonFrom(path, body, testSourceAddress);

const postCanonical = Effect.fn("test.postPATPairingCanonical")(function* (
  path: string,
  body: unknown,
  sessionBearer: string
) {
  return yield* HttpClient.post(path, {
    headers: {
      ...jsonHeaders,
      cookie: `${sessionCookieName}=${sessionBearer}`,
    },
    body: HttpBody.jsonUnsafe(body),
  });
});

const startPairing = Effect.gen(function* () {
  const response = yield* postJson("/pat-pairings", {
    recipientLabel: "Cliente de prueba",
    scopes: ["read", "dashboard"],
  });
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toContain("no-store");
  return yield* HttpClientResponse.schemaBodyJson(StartedPATPairing)(response);
});

const inspectPairing = Effect.fn("test.inspectPATPairing")(function* (publicCode: string) {
  const response = yield* postCanonical("/pats/pairings/inspect", { publicCode }, webSessionBearer);
  expect(response.status).toBe(200);
  return yield* HttpClientResponse.schemaBodyJson(OperationResponse(PATPairingReview))(response);
});

const approvePairing = Effect.fn("test.approvePATPairing")(function* (
  pairingId: string,
  patExpiresAt: DateTime.Utc
) {
  return yield* postCanonical(
    "/pats/pairings/approve",
    { pairingId, patExpiresAt },
    webSessionBearer
  );
});

const StoredPairing = Schema.Struct({
  lifecycle: Schema.String,
  tokenHash: Schema.NullOr(Schema.String),
  grantCount: Schema.Finite,
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "PAT pairing HTTP and PostgreSQL",
  (it) => {
    it.effect("approves atomically and discloses one bearer only to the proof holder", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const started = yield* startPairing;
        const review = yield* inspectPairing(started.publicCode);
        expect(review.data).toMatchObject({
          pairingId: started.pairingId,
          recipientLabel: "Cliente de prueba",
          scopes: ["read", "dashboard"],
          lifetimeDays: 90,
        });

        const approved = yield* approvePairing(review.data.pairingId, review.data.patExpiresAt);
        expect(approved.status).toBe(200);
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE pat_pairings SET last_accepted_poll_at = now() - interval '10 seconds'
          WHERE id = ${started.pairingId}
        `;
        const claims = yield* Effect.all(
          [
            postJson("/pat-pairings/claim", {
              pairingId: started.pairingId,
              privateDeviceCode: Redacted.value(started.privateDeviceCode),
            }),
            postJson("/pat-pairings/claim", {
              pairingId: started.pairingId,
              privateDeviceCode: Redacted.value(started.privateDeviceCode),
            }),
          ],
          { concurrency: "unbounded" }
        );
        expect(claims.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
          200, 400,
        ]);
        const claim = claims.find(({ status }) => status === 200);
        if (claim === undefined) return yield* Effect.die("expected one successful claim");
        expect(claim.headers["cache-control"]).toContain("no-store");
        const issued = yield* HttpClientResponse.schemaBodyJson(ClaimedPATPairing)(claim);
        expect(issued.bearer).toMatch(/^fin_/u);

        const [stored] = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: StoredPairing,
          execute: () => sql`
            SELECT pairing.lifecycle, token.token_hash AS "tokenHash",
              (SELECT count(*)::int FROM consent_records consent
                WHERE consent.pat_id = token.id) AS "grantCount"
            FROM pat_pairings pairing JOIN tokens token ON token.pat_pairing_id = pairing.id
            WHERE pairing.id = ${started.pairingId}
          `,
        })(undefined);
        expect(stored).toMatchObject({ lifecycle: "claimed", grantCount: 1 });
        expect(stored?.tokenHash).not.toBe(issued.bearer);

        const repeated = yield* postJson("/pat-pairings/claim", {
          pairingId: started.pairingId,
          privateDeviceCode: Redacted.value(started.privateDeviceCode),
        });
        expect(repeated.status).toBe(400);
      })
    );

    it.effect("inspects through the transaction-composable atomic batch path", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const started = yield* startPairing;
        const response = yield* postCanonical(
          "/operations/atomic-batch",
          {
            calls: [
              {
                callId: "f1d1a000-0000-4000-8000-000000000353",
                operation: "pats.inspectPATPairing",
                input: { payload: { publicCode: started.publicCode } },
              },
            ],
          },
          webSessionBearer
        );
        const responseBody = yield* response.json;
        expect(response.status).toBe(200);
        expect(responseBody).toMatchObject({
          data: {
            results: [
              {
                operation: "pats.inspectPATPairing",
                output: { data: { pairingId: started.pairingId } },
              },
            ],
          },
        });
      })
    );

    it.effect("rejects wrong caller, ownership, expiration, freshness, and approval replay", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        yield* seedFreshWebSessionFor({
          subjectUserId: secondUserId,
          patBearer: secondSeedBearer,
          sessionId: secondWebSessionId,
          sessionBearer: secondWebSessionBearer,
        });
        const started = yield* startPairing;
        const review = yield* inspectPairing(started.publicCode);
        const alteredExpiration = DateTime.subtractDuration(review.data.patExpiresAt, "1 second");

        const altered = yield* approvePairing(review.data.pairingId, alteredExpiration);
        const crossUserInspection = yield* postCanonical(
          "/pats/pairings/inspect",
          { publicCode: started.publicCode },
          secondWebSessionBearer
        );
        const crossUser = yield* postCanonical(
          "/pats/pairings/approve",
          { pairingId: review.data.pairingId, patExpiresAt: review.data.patExpiresAt },
          secondWebSessionBearer
        );
        const patCaller = yield* HttpClient.post("/pats/pairings/inspect", {
          headers: { ...jsonHeaders, ...headersFor(seedBearer) },
          body: HttpBody.jsonUnsafe({ publicCode: started.publicCode }),
        });
        expect([
          altered.status,
          crossUserInspection.status,
          crossUser.status,
          patCaller.status,
        ]).toEqual([400, 400, 400, 403]);

        const approved = yield* approvePairing(review.data.pairingId, review.data.patExpiresAt);
        const replay = yield* approvePairing(review.data.pairingId, review.data.patExpiresAt);
        expect([approved.status, replay.status]).toEqual([200, 400]);

        const staleRequest = yield* startPairing;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE web_sessions SET paired_at = paired_at - interval '11 minutes',
            fresh_until = fresh_until - interval '11 minutes',
            idle_expires_at = idle_expires_at - interval '11 minutes',
            hard_expires_at = hard_expires_at - interval '11 minutes'
          WHERE id = ${webSessionId}
        `;
        const stale = yield* postCanonical(
          "/pats/pairings/inspect",
          { publicCode: staleRequest.publicCode },
          webSessionBearer
        );
        expect(stale.status).toBe(401);
        const [count] = yield* sql`
          SELECT count(*)::int AS count FROM tokens
          WHERE pat_pairing_id = ${started.pairingId}
        `;
        expect(count?.count).toBe(1);
      })
    );

    it.effect("rolls approval back when Consent persistence fails", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const started = yield* startPairing;
        const review = yield* inspectPairing(started.publicCode);
        const sql = yield* MigrationSqlClient;
        const [before] = yield* sql`
          SELECT count(*)::int AS count FROM consent_records WHERE subject_user_id = ${userId}
        `;
        yield* sql`
          CREATE FUNCTION public.fidy_test_reject_pairing_consent() RETURNS trigger
          LANGUAGE plpgsql AS $function$
          BEGIN RAISE EXCEPTION 'forced pairing Consent failure'; END
          $function$;
          CREATE TRIGGER fidy_test_reject_pairing_consent
          BEFORE INSERT ON consent_records FOR EACH ROW
          EXECUTE FUNCTION public.fidy_test_reject_pairing_consent()
        `;
        const failed = yield* approvePairing(review.data.pairingId, review.data.patExpiresAt).pipe(
          Effect.ensuring(
            sql`
              DROP TRIGGER fidy_test_reject_pairing_consent ON consent_records;
              DROP FUNCTION public.fidy_test_reject_pairing_consent()
            `.pipe(Effect.orDie)
          )
        );
        expect(failed.status).toBe(500);
        const [after] = yield* sql`
          SELECT pairing.lifecycle, pairing.approved_at AS "approvedAt",
            (SELECT count(*)::int FROM tokens token
              WHERE token.pat_pairing_id = pairing.id) AS "tokenCount",
            (SELECT count(*)::int FROM consent_records
              WHERE subject_user_id = ${userId}) AS "consentCount"
          FROM pat_pairings pairing WHERE pairing.id = ${started.pairingId}
        `;
        expect(after).toMatchObject({
          lifecycle: "pending_approval",
          approvedAt: null,
          tokenCount: 0,
          consentCount: before?.count,
        });
      })
    );

    it.effect("gives claim and approved-expiry exactly one atomic winner", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const started = yield* startPairing;
        const review = yield* inspectPairing(started.publicCode);
        const approved = yield* approvePairing(review.data.pairingId, review.data.patExpiresAt);
        expect(approved.status).toBe(200);
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE pat_pairings
          SET created_at = now() + interval '250 milliseconds' - interval '10 minutes',
            expires_at = now() + interval '250 milliseconds',
            last_accepted_poll_at = now() - interval '10 seconds'
          WHERE id = ${started.pairingId}
        `;
        const lockAcquired = yield* Deferred.make<void>();
        const releaseLock = yield* Deferred.make<void>();
        const blocker = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM pat_pairings WHERE id = ${started.pairingId} FOR UPDATE`;
              yield* Deferred.succeed(lockAcquired, undefined);
              yield* Deferred.await(releaseLock);
            })
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(lockAcquired);
        const claim = yield* claimPATPairing(
          {
            pairingId: started.pairingId,
            privateDeviceCode: Redacted.value(started.privateDeviceCode),
          },
          testSourceAddress
        ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.sleep("300 millis");
        const expiry = yield* expireDuePATPairings().pipe(
          Effect.forkChild({ startImmediately: true })
        );
        yield* Deferred.succeed(releaseLock, undefined);
        yield* Effect.all([Fiber.join(blocker), Fiber.join(claim), Fiber.join(expiry)], {
          concurrency: "unbounded",
        });
        const [row] = yield* sql`
          SELECT pairing.lifecycle, token.token_hash AS "tokenHash",
            token.revoked_at AS "revokedAt",
            (SELECT count(*)::int FROM consent_records consent
              WHERE consent.pat_id = token.id
                OR consent.revoked_grant_id IN (
                  SELECT grant_record.id FROM consent_records grant_record
                  WHERE grant_record.pat_id = token.id
                )) AS "consentCount"
          FROM pat_pairings pairing JOIN tokens token ON token.pat_pairing_id = pairing.id
          WHERE pairing.id = ${started.pairingId}
        `;
        expect(["claimed", "revoked_unclaimed"]).toContain(row?.lifecycle);
        if (row?.lifecycle === "claimed") {
          expect(row).toMatchObject({
            revokedAt: null,
            consentCount: 1,
          });
        } else {
          expect(row).toMatchObject({ tokenHash: null, consentCount: 2 });
          expect(row?.revokedAt).not.toBeNull();
        }
      })
    );

    it.effect("deletes expired-unapproved requests after the retention window", () =>
      Effect.gen(function* () {
        const started = yield* startPairing;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE pat_pairings
          SET lifecycle = 'expired_unapproved', expired_at = now() - interval '25 hours'
          WHERE id = ${started.pairingId}
        `;
        yield* expireDuePATPairings();
        const [row] = yield* sql`
          SELECT count(*)::int AS count FROM pat_pairings WHERE id = ${started.pairingId}
        `;
        expect(row?.count).toBe(0);
      })
    );

    it.effect("deletes claimed request metadata after the retention window", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const started = yield* startPairing;
        const review = yield* inspectPairing(started.publicCode);
        const approved = yield* approvePairing(review.data.pairingId, review.data.patExpiresAt);
        expect(approved.status).toBe(200);
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE pat_pairings SET last_accepted_poll_at = now() - interval '10 seconds'
          WHERE id = ${started.pairingId}
        `;
        yield* claimPATPairing(
          {
            pairingId: started.pairingId,
            privateDeviceCode: Redacted.value(started.privateDeviceCode),
          },
          testSourceAddress
        );
        const [authorization] = yield* sql`
          SELECT id FROM tokens WHERE pat_pairing_id = ${started.pairingId}
        `;
        if (authorization === undefined) return yield* Effect.die("expected paired PAT");
        yield* sql`
          UPDATE pat_pairings SET claimed_at = now() - interval '25 hours'
          WHERE id = ${started.pairingId}
        `;
        yield* expireDuePATPairings();
        const [retained] = yield* sql`
          SELECT
            (SELECT count(*)::int FROM pat_pairings WHERE id = ${started.pairingId}) AS "pairingCount",
            (SELECT pat_pairing_id FROM tokens WHERE id = ${authorization.id}) AS "pairingReference"
        `;
        expect(retained).toMatchObject({ pairingCount: 0, pairingReference: null });
      })
    );

    it.effect("deletes revoked-unclaimed request metadata after the retention window", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const started = yield* startPairing;
        const review = yield* inspectPairing(started.publicCode);
        const approved = yield* approvePairing(review.data.pairingId, review.data.patExpiresAt);
        expect(approved.status).toBe(200);
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE pat_pairings SET created_at = now() - interval '10 minutes 1 second',
            expires_at = now() - interval '1 second'
          WHERE id = ${started.pairingId}
        `;
        yield* expireDuePATPairings();
        const [authorization] = yield* sql`
          SELECT id FROM tokens WHERE pat_pairing_id = ${started.pairingId}
        `;
        if (authorization === undefined) return yield* Effect.die("expected paired PAT");
        yield* sql`
          UPDATE pat_pairings SET revoked_at = now() - interval '25 hours'
          WHERE id = ${started.pairingId}
        `;
        yield* expireDuePATPairings();
        const [retained] = yield* sql`
          SELECT
            (SELECT count(*)::int FROM pat_pairings WHERE id = ${started.pairingId}) AS "pairingCount",
            (SELECT pat_pairing_id FROM tokens WHERE id = ${authorization.id}) AS "pairingReference"
        `;
        expect(retained).toMatchObject({ pairingCount: 0, pairingReference: null });
      })
    );

    it.effect("revokes approved-unclaimed authorization with automatic Consent evidence", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const started = yield* startPairing;
        const review = yield* inspectPairing(started.publicCode);
        const approved = yield* approvePairing(review.data.pairingId, review.data.patExpiresAt);
        expect(approved.status).toBe(200);
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE pat_pairings SET created_at = now() - interval '10 minutes 1 second',
            expires_at = now() - interval '1 second'
          WHERE id = ${started.pairingId}
        `;
        const expiredClaim = yield* postJson("/pat-pairings/claim", {
          pairingId: started.pairingId,
          privateDeviceCode: Redacted.value(started.privateDeviceCode),
        });
        expect(expiredClaim.status).toBe(400);

        expect(yield* expireDuePATPairings()).toEqual([]);
        const [row] = yield* sql`
          SELECT pairing.lifecycle, token.revoked_at AS "revokedAt",
            (SELECT count(*)::int FROM consent_records consent
              WHERE consent.pat_id = token.id
                OR consent.revoked_grant_id IN (
                  SELECT grant_record.id FROM consent_records grant_record
                  WHERE grant_record.pat_id = token.id
                )) AS "consentCount"
          FROM pat_pairings pairing JOIN tokens token ON token.pat_pairing_id = pairing.id
          WHERE pairing.id = ${started.pairingId}
        `;
        expect(row).toMatchObject({ lifecycle: "revoked_unclaimed", consentCount: 2 });
        expect(row?.revokedAt).not.toBeNull();
      })
    );

    it.effect("bounds malformed, start, claim-source, and polling abuse", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const sql = yield* MigrationSqlClient;
        const [before] = yield* sql`
          SELECT count(*)::int AS count FROM pat_pairings WHERE lifecycle = 'pending_approval'
        `;
        const malformedStart = yield* postJson("/pat-pairings", {
          recipientLabel: " ",
          scopes: ["admin"],
        });
        const [after] = yield* sql`
          SELECT count(*)::int AS count FROM pat_pairings WHERE lifecycle = 'pending_approval'
        `;
        expect(malformedStart.status).toBe(400);
        expect(after?.count).toBe(before?.count);

        const started = yield* startPairing;
        yield* Effect.forEach([1, 2, 3, 4], () => startPairing, { concurrency: 1 });
        const startLimited = yield* postJson("/pat-pairings", {
          recipientLabel: "Cliente excedente",
          scopes: ["read"],
        });
        expect(startLimited.status).toBe(429);
        const spoofedForwardingPrefixes = yield* Effect.forEach(
          ["198.51.100.200", "198.51.100.201"],
          (prefix) =>
            postJsonFrom(
              "/pat-pairings",
              { recipientLabel: "Cliente falsificado", scopes: ["read"] },
              `${prefix}, ${testSourceAddress}`
            ),
          { concurrency: 1 }
        );
        expect(spoofedForwardingPrefixes.every(({ status }) => status === 429)).toBe(true);
        const otherSource = yield* postJsonFrom(
          "/pat-pairings",
          { recipientLabel: "Otro cliente", scopes: ["read"] },
          secondTestSourceAddress
        );
        const missingSource = yield* HttpClient.post("/pat-pairings", {
          headers: { "content-type": "application/json" },
          body: HttpBody.jsonUnsafe({ recipientLabel: "Sin fuente", scopes: ["read"] }),
        });
        const malformedSource = yield* postJsonFrom(
          "/pat-pairings",
          { recipientLabel: "Fuente inválida", scopes: ["read"] },
          `not-an-address, ${testSourceAddress}`
        );
        expect([otherSource.status, missingSource.status, malformedSource.status]).toEqual([
          200, 503, 503,
        ]);
        if (before === undefined) return yield* Effect.die("expected pending pairing count");
        const [afterAdmission] = yield* sql`
          SELECT count(*)::int AS count FROM pat_pairings WHERE lifecycle = 'pending_approval'
        `;
        expect(afterAdmission?.count).toBe(Number(before.count) + 6);

        yield* sql`
          UPDATE pat_pairings SET last_accepted_poll_at = now() - interval '10 seconds'
          WHERE id = ${started.pairingId}
        `;
        const pending = yield* postJson("/pat-pairings/claim", {
          pairingId: started.pairingId,
          privateDeviceCode: Redacted.value(started.privateDeviceCode),
        });
        const tooFast = yield* postJson("/pat-pairings/claim", {
          pairingId: started.pairingId,
          privateDeviceCode: Redacted.value(started.privateDeviceCode),
        });
        expect([pending.status, tooFast.status]).toEqual([202, 429]);
        const [polling] = yield* sql`
          SELECT minimum_poll_interval_seconds AS "minimumSeconds"
          FROM pat_pairings WHERE id = ${started.pairingId}
        `;
        expect(polling?.minimumSeconds).toBe(10);

        yield* sql`DELETE FROM pat_pairing_claim_attempts`;
        const unknownClaim = {
          pairingId: "f1d1a000-0000-4000-8000-000000000399",
          privateDeviceCode: "u".repeat(43),
        };
        const acceptedAttempts = yield* Effect.forEach(
          Array.from({ length: 30 }),
          () => postJson("/pat-pairings/claim", unknownClaim),
          { concurrency: 1 }
        );
        expect(acceptedAttempts.every(({ status }) => status === 400)).toBe(true);
        const claimLimited = yield* postJson("/pat-pairings/claim", unknownClaim);
        expect(claimLimited.status).toBe(429);

        const rejectedReviews = yield* Effect.forEach(
          ["BCDF-GHJK", "BCDF-GHJL", "BCDF-GHJM", "BCDF-GHJN", "BCDF-GHJP", "BCDF-GHJQ"],
          (publicCode) => postCanonical("/pats/pairings/inspect", { publicCode }, webSessionBearer),
          { concurrency: "unbounded" }
        );
        const [inspectionAttempts] = yield* sql`
          SELECT count(*)::int AS count FROM pat_pairing_inspection_attempts
          WHERE user_id = ${userId}
        `;
        expect(inspectionAttempts?.count).toBe(5);
        expect(
          rejectedReviews.map(({ status }) => status).sort((left, right) => left - right)
        ).toEqual([400, 400, 400, 400, 400, 429]);
      })
    );

    it.effect(
      "keeps malformed and wrong proofs non-enumerating without creating authorization",
      () =>
        Effect.gen(function* () {
          yield* seedFreshWebSession;
          const started = yield* startPairing;
          const malformed = yield* postJson("/pat-pairings/claim", {
            pairingId: "not-an-id",
            privateDeviceCode: "wrong",
          });
          const wrong = yield* postJson("/pat-pairings/claim", {
            pairingId: started.pairingId,
            privateDeviceCode: "s".repeat(43),
          });
          const oversized = yield* postJson("/pat-pairings/claim", {
            pairingId: started.pairingId,
            privateDeviceCode: "s".repeat(257),
          });
          expect([malformed.status, wrong.status, oversized.status]).toEqual([400, 400, 400]);
          expect(yield* malformed.text).toBe(yield* wrong.text);
          const sql = yield* MigrationSqlClient;
          const [count] = yield* sql`
          SELECT count(*)::int AS count FROM tokens WHERE pat_pairing_id = ${started.pairingId}
        `;
          expect(count?.count).toBe(0);
        })
    );
  }
);
