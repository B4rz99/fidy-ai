import assert from "node:assert/strict";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Redacted, Result, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { SqlSchema } from "effect/unstable/sql";
import { allCanonicalCapabilities } from "~/core/_shared/canonical-capability";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import { UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import { TranscriptText } from "~/core/transcript/model";
import type { CanonicalCaller } from "~/shell/_shared/authz";
import {
  CanonicalCallRejected,
  executeHostedCanonicalOperation,
} from "~/shell/_shared/canonical-operation-executor";
import { immediatePermit, makeTurnConfirmation } from "~/shell/agent/tool-confirmation";
import { OperationResponse } from "~/shell/_shared/response";
import { agentOperationBindings } from "~/shell/agent/toolkit";
import { MigrationSqlClient } from "~/shell/db/client";
import { upsertUser } from "~/shell/identity/repo";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  BrowserLoginPairingApprovalRateLimited,
  BrowserLoginPairingApprovalRejected,
} from "./approval-errors";
import { BrowserLoginPairingApproval } from "./operations";

const firstUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008a1");
const secondUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008a2");
const binding = agentOperationBindings.find(
  (candidate) => candidate.operation === "browserLogin.approvePairing"
);
if (binding === undefined) throw new Error("browser login approval binding is missing");

const caller = (userId: UserId, suffix: string): CanonicalCaller => ({
  subjectUserId: userId,
  capabilities: allCanonicalCapabilities,
  auditCaller: {
    _tag: "HostedAgentSession",
    hostedAgentSessionId: HostedAgentSessionId.make(`f1d1a000-0000-4000-8000-0000000008${suffix}`),
  },
  authorityRoot: "verified-whatsapp",
});

const firstCaller = caller(firstUserId, "b1");
const secondCaller = caller(secondUserId, "b2");

const prepare = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`TRUNCATE browser_login_start_attempts, browser_login_pairings`;
  yield* sql`DELETE FROM audit_log_entries WHERE user_id IN (${firstUserId}, ${secondUserId})`;
  for (const userId of [firstUserId, secondUserId]) {
    yield* upsertUser(
      userId,
      yield* makeColombianUser(userId, {
        createdAt: DateTime.makeUnsafe("2026-08-01T12:00:00Z"),
        paidTier: "free",
      })
    );
  }
});

const start = Effect.gen(function* () {
  const response = yield* HttpClient.post("/web-auth/pairings");
  assert.equal(response.status, 200);
  return yield* Schema.decodeUnknownEffect(StartedBrowserLoginPairing)(yield* response.json);
});

const approve = (
  authority: CanonicalCaller,
  publicCode: string
): ReturnType<typeof executeHostedCanonicalOperation> => {
  const input = { payload: { publicCode } };
  return executeHostedCanonicalOperation({
    caller: authority,
    binding,
    untrustedInput: input,
    confirmationPermit: immediatePermit({ binding, input }),
    isExecutionActive: () => true,
  });
};

const StoredLifecycle = Schema.Struct({
  id: Schema.String,
  lifecycle: Schema.String,
  userId: Schema.NullOr(Schema.String),
  replacementId: Schema.NullOr(Schema.String),
});

const ApprovalHarness = ApiHarness.pipe(Layer.provideMerge(TelemetryDisabled));

layer(ApprovalHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "browser login approval",
  (it) => {
    it.effect("normalizes and atomically binds the public code to hosted User authority", () =>
      Effect.gen(function* () {
        yield* prepare;
        const challenge = yield* start;
        const submitted = challenge.publicCode.replace("-", "").toLowerCase();
        const result = yield* approve(firstCaller, submitted);
        const sql = yield* MigrationSqlClient;
        const stored = yield* SqlSchema.findOne({
          Request: Schema.String,
          Result: StoredLifecycle,
          execute: (id) => sql`
            SELECT id, lifecycle, user_id AS "userId", replacement_id AS "replacementId"
            FROM browser_login_pairings WHERE id = ${id}::uuid
          `,
        })(challenge.pairingId);

        expect(result).toMatchObject({
          data: { pairingId: challenge.pairingId },
          next: [],
        });
        assert.ok(Schema.is(OperationResponse(BrowserLoginPairingApproval))(result));
        expect(result.data.expiresAt).toEqual(challenge.expiresAt);
        expect(stored).toEqual({
          id: challenge.pairingId,
          lifecycle: "ready",
          userId: firstUserId,
          replacementId: null,
        });
      })
    );

    it.effect("renders exact confirmation with only the public code in hosted evidence", () =>
      Effect.gen(function* () {
        yield* prepare;
        const challenge = yield* start;
        const input = { payload: { publicCode: challenge.publicCode } };
        const confirmation = yield* makeTurnConfirmation(firstUserId, [], {
          text: TranscriptText.make(`Approve ${challenge.publicCode}`),
        });
        const decision = yield* confirmation.decide({ binding, input });
        assert.equal(decision._tag, "RequireConfirmation");
        const retained = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
          input,
          challenge: decision.failure.challenge,
          toolSchema: binding.wireJsonSchema,
        });
        expect(retained).toContain("browserLogin.approvePairing");
        expect(retained).toContain(challenge.publicCode);
        expect(retained).not.toContain(Redacted.value(challenge.privateVerifier));
        expect(retained).not.toContain("privateVerifier");
      })
    );

    it.effect("rejects hosted work not rooted in a verified WhatsApp association", () =>
      Effect.gen(function* () {
        yield* prepare;
        const challenge = yield* start;
        const denied = yield* Effect.result(
          approve(
            { ...firstCaller, authorityRoot: "no-verified-whatsapp-authority" },
            challenge.publicCode
          )
        );
        assert.ok(Result.isFailure(denied));
        expect(denied.failure).toEqual(new CanonicalCallRejected({ reason: "caller_ineligible" }));
        const sql = yield* MigrationSqlClient;
        const rows = yield* sql`
          SELECT lifecycle, user_id AS "userId" FROM browser_login_pairings
          WHERE id = ${challenge.pairingId}::uuid
        `;
        expect(rows).toEqual([{ lifecycle: "pending_approval", userId: null }]);
      })
    );

    it.effect("rejects expired and replayed public codes without changing their bindings", () =>
      Effect.gen(function* () {
        yield* prepare;
        const expired = yield* start;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_login_pairings
          SET created_at = now() - interval '20 minutes',
            expires_at = now() - interval '10 minutes'
          WHERE id = ${expired.pairingId}::uuid
        `;
        const expiredAttempt = yield* Effect.result(approve(firstCaller, expired.publicCode));
        assert.ok(Result.isFailure(expiredAttempt));
        expect(expiredAttempt.failure).toBeInstanceOf(BrowserLoginPairingApprovalRejected);

        const ready = yield* start;
        yield* approve(firstCaller, ready.publicCode);
        const replay = yield* Effect.result(approve(firstCaller, ready.publicCode));
        assert.ok(Result.isFailure(replay));
        expect(replay.failure).toBeInstanceOf(BrowserLoginPairingApprovalRejected);
        const rows = yield* sql`
          SELECT id, lifecycle, user_id AS "userId"
          FROM browser_login_pairings ORDER BY created_ordinal
        `;
        expect(rows).toEqual([
          { id: expired.pairingId, lifecycle: "expired", userId: null },
          { id: ready.pairingId, lifecycle: "ready", userId: firstUserId },
        ]);
      })
    );

    it.effect("supersedes the older Ready pairing when a newer code is approved", () =>
      Effect.gen(function* () {
        yield* prepare;
        const older = yield* start;
        yield* approve(firstCaller, older.publicCode);
        const newer = yield* start;
        yield* approve(firstCaller, newer.publicCode);
        const sql = yield* MigrationSqlClient;
        const rows = yield* sql`
          SELECT id, lifecycle, replacement_id AS "replacementId"
          FROM browser_login_pairings ORDER BY created_at
        `;

        expect(rows).toEqual([
          { id: older.pairingId, lifecycle: "superseded", replacementId: newer.pairingId },
          { id: newer.pairingId, lifecycle: "ready", replacementId: null },
        ]);
      })
    );

    it.effect("allows only one concurrent User to bind the same challenge", () =>
      Effect.gen(function* () {
        yield* prepare;
        const challenge = yield* start;
        const outcomes = yield* Effect.all(
          [
            Effect.result(approve(firstCaller, challenge.publicCode)),
            Effect.result(approve(secondCaller, challenge.publicCode)),
          ],
          { concurrency: "unbounded" }
        );
        expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
        expect(outcomes.filter(Result.isFailure)).toHaveLength(1);
        const loser = outcomes.find(Result.isFailure);
        assert.ok(loser !== undefined && Result.isFailure(loser));
        expect(loser.failure).toBeInstanceOf(BrowserLoginPairingApprovalRejected);
        const sql = yield* MigrationSqlClient;
        const rows = yield* sql`
          SELECT user_id AS "userId", lifecycle FROM browser_login_pairings
          WHERE id = ${challenge.pairingId}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.lifecycle).toBe("ready");
        expect([firstUserId, secondUserId]).toContain(rows[0]?.userId);
      })
    );

    it.effect("uses five metadata-only rejected audits to rate-limit the sixth submission", () =>
      Effect.gen(function* () {
        yield* prepare;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const outcome = yield* Effect.result(approve(firstCaller, "not a pairing code"));
          assert.ok(Result.isFailure(outcome));
          expect(outcome.failure).toBeInstanceOf(BrowserLoginPairingApprovalRejected);
        }
        const limited = yield* Effect.result(approve(firstCaller, "still invalid"));
        assert.ok(Result.isFailure(limited));
        expect(limited.failure).toBeInstanceOf(BrowserLoginPairingApprovalRateLimited);
        assert.ok(Schema.is(BrowserLoginPairingApprovalRateLimited)(limited.failure));
        const retryAfterSeconds = limited.failure.error.retryAfterSeconds;
        const repeated = yield* Effect.result(approve(firstCaller, "still invalid"));
        assert.ok(Result.isFailure(repeated));
        assert.ok(Schema.is(BrowserLoginPairingApprovalRateLimited)(repeated.failure));
        expect(repeated.failure.error.retryAfterSeconds).toBe(retryAfterSeconds);
        const sql = yield* MigrationSqlClient;
        const evidence = yield* sql`
          SELECT operation, outcome FROM audit_log_entries
          WHERE user_id = ${firstUserId}::uuid ORDER BY occurred_at
        `;
        expect(evidence).toEqual(
          Array.from({ length: 7 }, () => ({
            operation: "browserLogin.approvePairing",
            outcome: "rejected",
          }))
        );
      })
    );
  }
);
