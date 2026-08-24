import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import { UserId } from "~/core/identity/reference";
import { WebSessionBearer } from "~/core/web-session/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiTelemetryHarness } from "~/shell/testing/api-harness";
import { transactionEnvelopePayloads } from "~/shell/testing/telemetry-envelope-fixtures";
import { EnvelopeRecorder } from "./envelope-recorder";

const resetBrowserLogin = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM consent_records WHERE decision_web_session_id IS NOT NULL`;
  yield* sql`TRUNCATE web_sessions, browser_login_start_attempts, browser_login_pairings`;
});
const telemetryUserId = UserId.make("24000000-0000-4000-8000-000000000244");

layer(ApiTelemetryHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "WebAuth telemetry",
  (it) => {
    it.effect("records only closed redemption status, reason, retry, and latency coordinates", () =>
      Effect.gen(function* () {
        yield* resetBrowserLogin;
        const startedResponse = yield* HttpClient.post("/web/pairings");
        const started = yield* Schema.decodeUnknownEffect(StartedBrowserLoginPairing)(
          yield* startedResponse.json
        );
        const redemptionPayload = {
          pairingId: started.pairingId,
          privateVerifier: Redacted.value(started.privateVerifier),
        };
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_login_pairings
          SET last_accepted_poll_at = now() - interval '5 seconds'
          WHERE id = ${started.pairingId}::uuid
        `;
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;

        const pending = yield* HttpClient.post("/web/pairings/redeem", {
          body: HttpBody.jsonUnsafe(redemptionPayload),
        });
        const rateLimited = yield* HttpClient.post("/web/pairings/redeem", {
          body: HttpBody.jsonUnsafe(redemptionPayload),
        });
        const invalid = yield* HttpClient.post("/web/pairings/redeem", {
          body: HttpBody.jsonUnsafe({
            pairingId: "24000000-0000-4000-8000-000000000243",
            privateVerifier: "x".repeat(43),
          }),
        });
        yield* sql`
          INSERT INTO users (
            id, service_market, locale, time_zone, created_at,
            paid_tier, trial_started_at, trial_ends_at
          ) VALUES (
            ${telemetryUserId}, 'CO', 'es-CO', 'America/Bogota', now(),
            'free', now(), now() + interval '168 hours'
          )
          ON CONFLICT (id) DO NOTHING
        `;
        yield* sql`
          UPDATE browser_login_pairings
          SET user_id = ${telemetryUserId}, lifecycle = 'ready', approved_at = now(),
              last_accepted_poll_at = now() - interval '1 minute'
          WHERE id = ${started.pairingId}::uuid
        `;
        const authenticated = yield* HttpClient.post("/web/pairings/redeem", {
          body: HttpBody.jsonUnsafe(redemptionPayload),
        });
        const setCookie = authenticated.headers["set-cookie"] ?? "";
        const sessionBearer = yield* Schema.decodeUnknownEffect(WebSessionBearer)(
          /__Host-fidy_session=([A-Za-z0-9_-]{43})/u.exec(setCookie)?.[1]
        );

        expect([pending.status, rateLimited.status, invalid.status, authenticated.status]).toEqual([
          202, 429, 400, 200,
        ]);
        const envelopes = yield* recorder.serializedEnvelopes;
        const redemptions = transactionEnvelopePayloads(envelopes).filter(
          (transaction) => transaction.tags.operation === "browserLogin.redeemPairing"
        );
        expect(redemptions).toHaveLength(4);
        expect(redemptions.map((transaction) => transaction.contexts.trace.data)).toEqual([
          expect.objectContaining({
            "http.request.method": "POST",
            "http.response.status_code": 202,
            "http.route": "/web/pairings/redeem",
          }),
          expect.objectContaining({
            "http.response.status_code": 429,
          }),
          expect.objectContaining({
            "http.response.status_code": 400,
          }),
          expect.objectContaining({
            "http.response.status_code": 200,
          }),
        ]);
        for (const redemption of redemptions) {
          expect(typeof redemption.contexts.trace.data["fidy.duration_milliseconds"]).toBe(
            "number"
          );
        }
        expect(redemptions.map((transaction) => transaction.tags)).toEqual([
          expect.objectContaining({ outcome: "succeeded", retryable: "false" }),
          expect.objectContaining({
            outcome: "failed",
            error: "rate_limited",
            retryable: "true",
          }),
          expect.objectContaining({
            outcome: "rejected",
            error: "pairing_invalid",
            retryable: "false",
          }),
          expect.objectContaining({ outcome: "succeeded", retryable: "false" }),
        ]);
        const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");
        expect(serialized).not.toContain(started.pairingId);
        expect(serialized).not.toContain(Redacted.value(started.privateVerifier));
        expect(serialized).not.toContain("24000000-0000-4000-8000-000000000243");
        expect(serialized).not.toContain(telemetryUserId);
        expect(serialized).not.toContain(sessionBearer);
        expect(serialized).not.toContain("__Host-fidy_session");
        expect(serialized.toLowerCase()).not.toContain("set-cookie");
        expect(serialized).not.toContain(`"request"`);
        expect(serialized).not.toContain(`"response"`);
      })
    );
  }
);
