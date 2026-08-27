import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Effect, Redacted, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { UserId } from "~/core/identity/reference";
import {
  ActivePATList,
  RevokedPAT,
  RevokedPATCount,
  TokenBearer,
  defaultPATLifetimeDays,
} from "~/core/tokens/model";
import { ClaimedPATPairing, PATPairingReview, StartedPATPairing } from "~/core/tokens/pairing";
import { computePATExpiration } from "~/core/tokens/rules";
import { WebSessionId } from "~/core/web-session/reference";
import { calculateWebSessionDeadlines } from "~/core/web-session/rules";
import { OperationResponse } from "~/shell/_shared/response";
import { MigrationSqlClient } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { IssuedManualPATResponse } from "./operations";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000250");
const seedBearer = TokenBearer.make("fin_seed0250_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const foreignUserId = UserId.make("f1d1a000-0000-4000-8000-000000000259");
const foreignBearer = TokenBearer.make("fin_foreign2_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const webSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000251");
const webSessionBearer = "j".repeat(43);
const foreignWebSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000258");
const foreignWebSessionBearer = "k".repeat(43);
const sessionCookieName = "__Host-fidy_session";

const seedFreshWebSessionFor = Effect.fn("test.seedFreshWebSessionFor")(function* (input: {
  readonly subjectUserId: UserId;
  readonly identityBearer: TokenBearer;
  readonly sessionId: WebSessionId;
  readonly sessionBearer: string;
}) {
  yield* seedConsentedPatIdentity({ userId: input.subjectUserId, bearer: input.identityBearer });
  const now = yield* DateTime.now;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* MigrationSqlClient;
  const bearerDigest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(input.sessionBearer))
    .pipe(Effect.orDie);
  const deadlines = calculateWebSessionDeadlines(now);
  yield* sql`
    DELETE FROM consent_records
    WHERE subject_user_id = ${input.subjectUserId} AND revoked_grant_id IN (
      SELECT id FROM consent_records
      WHERE subject_user_id = ${input.subjectUserId} AND grant_type = 'pat'
    )
  `;
  yield* sql`
    DELETE FROM consent_records
    WHERE subject_user_id = ${input.subjectUserId} AND grant_type = 'pat'
  `;
  yield* sql`DELETE FROM tokens WHERE user_id = ${input.subjectUserId}`;
  yield* sql`DELETE FROM pat_pairings WHERE user_id = ${input.subjectUserId}`;
  yield* sql`DELETE FROM web_sessions WHERE user_id = ${input.subjectUserId}`;
  yield* sql`
    INSERT INTO web_sessions (
      id, user_id, bearer_digest, paired_at, fresh_until, idle_expires_at, hard_expires_at
    ) VALUES (
      ${input.sessionId}, ${input.subjectUserId}, ${bearerDigest}, ${now}, ${deadlines.freshUntil},
      ${deadlines.idleExpiresAt}, ${deadlines.hardExpiresAt}
    )
  `;
});

const seedFreshWebSession = seedFreshWebSessionFor({
  subjectUserId: userId,
  identityBearer: seedBearer,
  sessionId: webSessionId,
  sessionBearer: webSessionBearer,
});

const webHeaders = {
  cookie: `${sessionCookieName}=${webSessionBearer}`,
  "content-type": "application/json",
} as const;

const foreignWebHeaders = {
  cookie: `${sessionCookieName}=${foreignWebSessionBearer}`,
  "content-type": "application/json",
} as const;

const makeWebSessionStale = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  const pairedAt = DateTime.subtract(yield* DateTime.now, { hours: 1 });
  const deadlines = calculateWebSessionDeadlines(pairedAt);
  yield* sql`
    UPDATE web_sessions
    SET paired_at = ${pairedAt}, fresh_until = ${deadlines.freshUntil},
      idle_expires_at = ${deadlines.idleExpiresAt}, hard_expires_at = ${deadlines.hardExpiresAt}
    WHERE id = ${webSessionId}
  `;
});

const seedApprovedUnclaimedPairing = Effect.fn("test.seedApprovedUnclaimedPairing")(function* (
  sourceAddress: string,
  recipientLabel: string
) {
  const startedResponse = yield* HttpClient.post("/pat-pairings", {
    headers: { "content-type": "application/json", "x-forwarded-for": sourceAddress },
    body: HttpBody.jsonUnsafe({ recipientLabel, scopes: ["read"] }),
  });
  const started = yield* HttpClientResponse.schemaBodyJson(StartedPATPairing)(startedResponse);
  const inspectedResponse = yield* HttpClient.post("/pats/pairings/inspect", {
    headers: webHeaders,
    body: HttpBody.jsonUnsafe({ publicCode: started.publicCode }),
  });
  const inspected = yield* HttpClientResponse.schemaBodyJson(OperationResponse(PATPairingReview))(
    inspectedResponse
  );
  const approved = yield* HttpClient.post("/pats/pairings/approve", {
    headers: webHeaders,
    body: HttpBody.jsonUnsafe({
      pairingId: inspected.data.pairingId,
      patExpiresAt: DateTime.formatIso(inspected.data.patExpiresAt),
    }),
  });
  expect(approved.status).toBe(200);
  return started;
});

const capturePATLifecycle = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  const tokens = yield* sql`
    SELECT user_id, short_id, revoked_at FROM tokens
    WHERE user_id IN (${userId}, ${foreignUserId}) ORDER BY user_id, short_id
  `;
  const pairings = yield* sql`
    SELECT user_id, lifecycle, revoked_at FROM pat_pairings
    WHERE user_id IN (${userId}, ${foreignUserId}) ORDER BY user_id, id
  `;
  const revocations = yield* sql`
    SELECT subject_user_id, revoked_grant_id FROM consent_records
    WHERE subject_user_id IN (${userId}, ${foreignUserId}) AND revoked_grant_id IS NOT NULL
    ORDER BY subject_user_id, id
  `;
  return { tokens, pairings, revocations } as const;
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })("PAT management", (it) => {
  it.effect("lists only safe metadata for the User's active PATs", () =>
    Effect.gen(function* () {
      yield* seedFreshWebSession;
      const now = yield* DateTime.now;
      const reviewExpiresAt = yield* computePATExpiration({
        createdAt: now,
        lifetimeDays: defaultPATLifetimeDays,
      });
      const issued = yield* HttpClient.post("/pats", {
        headers: webHeaders,
        body: HttpBody.jsonUnsafe({
          requestId: "f1d1a000-0000-4000-8000-000000000252",
          grant: {
            recipientLabel: "Robot de reportes",
            scopes: ["read", "dashboard"],
            lifetimeDays: defaultPATLifetimeDays,
            reviewExpiresAt: DateTime.formatIso(reviewExpiresAt),
          },
        }),
      });
      expect(issued.status).toBe(200);

      const response = yield* HttpClient.get("/pats", { headers: webHeaders });
      const body = yield* Schema.decodeUnknownEffect(OperationResponse(ActivePATList))(
        yield* response.json
      );

      expect(response.status).toBe(200);
      expect(body.data.pats).toEqual([
        expect.objectContaining({
          recipientLabel: "Robot de reportes",
          scopes: ["read", "dashboard"],
        }),
      ]);
      const listed = body.data.pats[0];
      if (listed === undefined) return yield* Effect.die("active PAT was absent");
      expect(Object.keys(listed).toSorted()).toEqual([
        "createdAt",
        "expiresAt",
        "lastUsedAt",
        "recipientLabel",
        "scopes",
        "shortId",
      ]);
    })
  );

  it.effect("revokes one PAT atomically and immediately rejects its bearer", () =>
    Effect.gen(function* () {
      yield* seedFreshWebSession;
      const now = yield* DateTime.now;
      const reviewExpiresAt = yield* computePATExpiration({
        createdAt: now,
        lifetimeDays: defaultPATLifetimeDays,
      });
      const issuedResponse = yield* HttpClient.post("/pats", {
        headers: webHeaders,
        body: HttpBody.jsonUnsafe({
          requestId: "f1d1a000-0000-4000-8000-000000000253",
          grant: {
            recipientLabel: "Revocable robot",
            scopes: ["read"],
            lifetimeDays: defaultPATLifetimeDays,
            reviewExpiresAt: DateTime.formatIso(reviewExpiresAt),
          },
        }),
      });
      const issued = yield* Schema.decodeUnknownEffect(OperationResponse(IssuedManualPATResponse))(
        yield* issuedResponse.json
      );

      const revoked = yield* HttpClient.del(`/pats/${issued.data.pat.shortId}`, {
        headers: webHeaders,
      });
      const revokedBody = yield* Schema.decodeUnknownEffect(OperationResponse(RevokedPAT))(
        yield* revoked.json
      );
      const rejectedBearer = yield* HttpClient.get("/categories", {
        headers: { authorization: `Bearer ${issued.data.bearer}` },
      });
      const retry = yield* HttpClient.del(`/pats/${issued.data.pat.shortId}`, {
        headers: webHeaders,
      });
      const listed = yield* HttpClient.get("/pats", { headers: webHeaders });
      const listedBody = yield* Schema.decodeUnknownEffect(OperationResponse(ActivePATList))(
        yield* listed.json
      );
      const sql = yield* MigrationSqlClient;
      const evidence = yield* sql`
          SELECT event_type, decision_origin, web_session_id
          FROM consent_records
          WHERE subject_user_id = ${userId} AND grant_type = 'pat'
             OR subject_user_id = ${userId} AND revoked_grant_id IN (
               SELECT id FROM consent_records
               WHERE subject_user_id = ${userId} AND grant_type = 'pat'
             )
          ORDER BY occurred_at, id
        `;

      expect(revoked.status).toBe(200);
      expect(revokedBody.data.shortId).toBe(issued.data.pat.shortId);
      expect(rejectedBearer.status).toBe(401);
      expect(retry.status).toBe(200);
      expect(listedBody.data.pats).toEqual([]);
      expect(evidence).toHaveLength(2);
      expect(evidence[0]).toMatchObject({
        event_type: "granted",
        decision_origin: "authenticated-web",
        web_session_id: webSessionId,
      });
      expect(evidence[1]).toMatchObject({
        event_type: "revoked",
        decision_origin: "authenticated-web",
        web_session_id: webSessionId,
      });
    })
  );

  it.effect("revokes all active PATs with one symmetric Consent record each", () =>
    Effect.gen(function* () {
      yield* seedFreshWebSession;
      const now = yield* DateTime.now;
      const reviewExpiresAt = yield* computePATExpiration({
        createdAt: now,
        lifetimeDays: defaultPATLifetimeDays,
      });
      for (const [requestId, recipientLabel] of [
        ["f1d1a000-0000-4000-8000-000000000254", "First robot"],
        ["f1d1a000-0000-4000-8000-000000000255", "Second robot"],
      ] as const) {
        const issued = yield* HttpClient.post("/pats", {
          headers: webHeaders,
          body: HttpBody.jsonUnsafe({
            requestId,
            grant: {
              recipientLabel,
              scopes: ["read"],
              lifetimeDays: defaultPATLifetimeDays,
              reviewExpiresAt: DateTime.formatIso(reviewExpiresAt),
            },
          }),
        });
        expect(issued.status).toBe(200);
      }

      const revoked = yield* HttpClient.del("/pats", { headers: webHeaders });
      const body = yield* Schema.decodeUnknownEffect(OperationResponse(RevokedPATCount))(
        yield* revoked.json
      );
      const sql = yield* MigrationSqlClient;
      const counts = yield* sql`
          SELECT event_type, count(*)::int AS count
          FROM consent_records
          WHERE subject_user_id = ${userId}
            AND (grant_type = 'pat' OR revoked_grant_id IN (
              SELECT id FROM consent_records
              WHERE subject_user_id = ${userId} AND grant_type = 'pat'
            ))
          GROUP BY event_type ORDER BY event_type
        `;

      expect(revoked.status).toBe(200);
      expect(body.data.revokedCount).toBe(2);
      expect(counts).toEqual([
        { event_type: "granted", count: 2 },
        { event_type: "revoked", count: 2 },
      ]);
    })
  );

  it.effect("revoke-all closes approved unclaimed PAT authorization without counting it", () =>
    Effect.gen(function* () {
      yield* seedFreshWebSession;
      const started = yield* seedApprovedUnclaimedPairing("203.0.113.250", "Pending robot");

      const revoked = yield* HttpClient.del("/pats", { headers: webHeaders });
      const body = yield* Schema.decodeUnknownEffect(OperationResponse(RevokedPATCount))(
        yield* revoked.json
      );
      const sql = yield* MigrationSqlClient;
      const stored = yield* sql`
          SELECT pairing.lifecycle, token.revoked_at IS NOT NULL AS token_revoked,
            (SELECT count(*)::int FROM consent_records consent
             WHERE consent.revoked_grant_id IN (
               SELECT id FROM consent_records
               WHERE subject_user_id = ${userId} AND pat_id = token.id
             )) AS revocation_count
          FROM pat_pairings pairing JOIN tokens token ON token.pat_pairing_id = pairing.id
          WHERE pairing.id = ${started.pairingId}
        `;

      expect(revoked.status).toBe(200);
      expect(body.data.revokedCount).toBe(0);
      expect(stored).toEqual([
        { lifecycle: "revoked_unclaimed", token_revoked: true, revocation_count: 1 },
      ]);
    })
  );

  it.effect("keeps revoke-all coherent while an approved pairing is claimed", () =>
    Effect.gen(function* () {
      yield* seedFreshWebSession;
      const started = yield* seedApprovedUnclaimedPairing("203.0.113.254", "Racing robot");
      const sql = yield* MigrationSqlClient;
      yield* sql`
        UPDATE pat_pairings SET last_accepted_poll_at = now() - interval '10 seconds'
        WHERE id = ${started.pairingId}
      `;

      const [claim, revoked] = yield* Effect.all(
        [
          HttpClient.post("/pat-pairings/claim", {
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": "203.0.113.254",
            },
            body: HttpBody.jsonUnsafe({
              pairingId: started.pairingId,
              privateDeviceCode: Redacted.value(started.privateDeviceCode),
            }),
          }),
          HttpClient.del("/pats", { headers: webHeaders }),
        ],
        { concurrency: "unbounded" }
      );
      expect(revoked.status).toBe(200);
      expect([200, 400]).toContain(claim.status);
      if (claim.status === 200) {
        const issued = yield* HttpClientResponse.schemaBodyJson(ClaimedPATPairing)(claim);
        const rejectedBearer = yield* HttpClient.get("/categories", {
          headers: { authorization: `Bearer ${issued.bearer}` },
        });
        expect(rejectedBearer.status).toBe(401);
      }
      const [stored] = yield* sql`
        SELECT pairing.lifecycle, token.revoked_at IS NOT NULL AS token_revoked,
          (SELECT count(*)::int FROM consent_records consent
            WHERE consent.pat_id = token.id AND consent.event_type = 'granted') AS grant_count,
          (SELECT count(*)::int FROM consent_records consent
            WHERE consent.revoked_grant_id IN (
              SELECT id FROM consent_records grant_record
              WHERE grant_record.pat_id = token.id AND grant_record.event_type = 'granted'
            )) AS revocation_count
        FROM pat_pairings pairing JOIN tokens token ON token.pat_pairing_id = pairing.id
        WHERE pairing.id = ${started.pairingId}
      `;
      expect(["claimed", "revoked_unclaimed"]).toContain(stored?.lifecycle);
      expect(stored).toMatchObject({ token_revoked: true, grant_count: 1, revocation_count: 1 });
    })
  );

  it.effect("rejects stale web revocations without changing PAT lifecycle evidence", () =>
    Effect.gen(function* () {
      yield* seedFreshWebSession;
      yield* seedConsentedPatIdentity({ userId, bearer: seedBearer });
      yield* seedApprovedUnclaimedPairing("203.0.113.252", "Stale-session robot");
      const before = yield* capturePATLifecycle;
      yield* makeWebSessionStale;

      const revokeOne = yield* HttpClient.del("/pats/seed0250", { headers: webHeaders });
      const revokeAll = yield* HttpClient.del("/pats", { headers: webHeaders });
      const after = yield* capturePATLifecycle;

      expect(revokeOne.status).toBe(401);
      expect(revokeAll.status).toBe(401);
      expect(after).toEqual(before);
    })
  );

  it.effect("keeps one User's PATs isolated from another fresh web User", () =>
    Effect.gen(function* () {
      yield* seedFreshWebSession;
      yield* seedConsentedPatIdentity({ userId, bearer: seedBearer });
      yield* seedApprovedUnclaimedPairing("203.0.113.253", "Other-user protected robot");
      yield* seedFreshWebSessionFor({
        subjectUserId: foreignUserId,
        identityBearer: foreignBearer,
        sessionId: foreignWebSessionId,
        sessionBearer: foreignWebSessionBearer,
      });
      const before = yield* capturePATLifecycle;

      const listed = yield* HttpClient.get("/pats", { headers: foreignWebHeaders });
      const listedBody = yield* Schema.decodeUnknownEffect(OperationResponse(ActivePATList))(
        yield* listed.json
      );
      const revoked = yield* HttpClient.del("/pats", { headers: foreignWebHeaders });
      const revokedBody = yield* Schema.decodeUnknownEffect(OperationResponse(RevokedPATCount))(
        yield* revoked.json
      );
      const after = yield* capturePATLifecycle;

      expect(listed.status).toBe(200);
      expect(listedBody.data.pats).toEqual([]);
      expect(revoked.status).toBe(200);
      expect(revokedBody.data.revokedCount).toBe(0);
      expect(after).toEqual(before);
    })
  );

  it.effect(
    "does not enumerate foreign ids and denies PAT callers every management operation",
    () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        yield* seedConsentedPatIdentity({ userId, bearer: seedBearer });
        yield* seedConsentedPatIdentity({ userId: foreignUserId, bearer: foreignBearer });
        yield* seedApprovedUnclaimedPairing("203.0.113.251", "Protected pending robot");
        const before = yield* capturePATLifecycle;

        const foreign = yield* HttpClient.del("/pats/foreign2", { headers: webHeaders });
        const unknown = yield* HttpClient.del("/pats/deadbeef", { headers: webHeaders });
        const foreignBody = yield* foreign.json;
        const unknownBody = yield* unknown.json;
        const patHeaders = { authorization: `Bearer ${seedBearer}` } as const;
        const patList = yield* HttpClient.get("/pats", { headers: patHeaders });
        const patRevokeOne = yield* HttpClient.del("/pats/seed0250", { headers: patHeaders });
        const patRevokeAll = yield* HttpClient.del("/pats", { headers: patHeaders });
        const after = yield* capturePATLifecycle;

        expect(foreign.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(foreignBody).toEqual(unknownBody);
        expect(patList.status).toBe(403);
        expect(patRevokeOne.status).toBe(403);
        expect(patRevokeAll.status).toBe(403);
        expect(after).toEqual(before);
      })
  );
});
