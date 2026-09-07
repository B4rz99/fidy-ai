import { UnknownJsonString } from "~/schema-compatibility";
import { expect, layer } from "@effect/vitest";
import {
  ConfigProvider,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import type { SqlClient } from "effect/unstable/sql";
import {
  EmailAddress,
  EmailVerificationCode,
  maximumEmailDeliveryGenerations,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { WebSessionId } from "~/core/web-session/reference";
import { calculateWebSessionDeadlines } from "~/core/web-session/rules";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { MigrationSqlClient } from "~/shell/db/client";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { admitEmailDeliveryInScope, emailCredentialLookupKey } from "./admission";
import { EmailDeliveryPort, EmailSendFailed } from "./delivery";
import { performReplacementAttempt } from "./replacement-delivery-worker";
import { ReplacementDeliveryPayload, ReplacementExpiryPayload } from "./replacement-protocol";
import { expireReplacement, removeReplacementLifecycleEventsBefore } from "./replacement-retention";
import { completeEmailReplacement } from "./replacement-transition";
import { ApiHarness } from "~/shell/testing/api-harness";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000325");
const bearer = TokenBearer.make("fin_replace1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const webSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000326");
const webSessionBearer = "y".repeat(43);
const sessionCookie = `__Host-fidy_session=${webSessionBearer}`;
const alternateWebSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000329");
const alternateWebSessionBearer = "2".repeat(43);
const alternateSessionCookie = `__Host-fidy_session=${alternateWebSessionBearer}`;
const strangerUserId = UserId.make("f1d1a000-0000-4000-8000-000000000327");
const strangerBearer = TokenBearer.make("fin_replace2_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const strangerWebSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000328");
const strangerWebSessionBearer = "z".repeat(43);
const strangerSessionCookie = `__Host-fidy_session=${strangerWebSessionBearer}`;
const encodedBodySize = (body: unknown): number =>
  Schema.encodeSync(UnknownJsonString)(body).length;

const seedReplacementSession = Effect.fn("seedReplacementSession")(function* (input: {
  subjectUserId: UserId;
  tokenBearer: TokenBearer;
  sessionId: WebSessionId;
  sessionBearer: string;
}) {
  yield* seedConsentedPatIdentity({ userId: input.subjectUserId, bearer: input.tokenBearer });
  const now = yield* DateTime.now;
  const deadlines = calculateWebSessionDeadlines(now);
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(input.sessionBearer))
    .pipe(Effect.orDie);
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${input.subjectUserId}`;
  yield* sql`DELETE FROM email_replacement_workflows WHERE user_id = ${input.subjectUserId}`;
  yield* sql`DELETE FROM fidy_durable.fidy_queue
    WHERE queue_name IN ('email-replacement-delivery', 'email-replacement-expiry')
      AND element::jsonb->>'userId' = ${input.subjectUserId}`;
  yield* sql`DELETE FROM email_replacement_executions WHERE user_id = ${input.subjectUserId}`;
  yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${input.subjectUserId}`;
  yield* sql`
    UPDATE verified_email_credentials SET email_address = ${`seed-${input.subjectUserId}@fidyapp.com`},
      verified_at = ${now} WHERE user_id = ${input.subjectUserId}
  `;
  yield* sql`DELETE FROM web_sessions WHERE user_id = ${input.subjectUserId}`;
  yield* sql`
    INSERT INTO web_sessions (
      id, user_id, bearer_digest, paired_at, fresh_until, idle_expires_at, hard_expires_at
    ) VALUES (
      ${input.sessionId}, ${input.subjectUserId}, ${digest}, ${now}, ${deadlines.freshUntil},
      ${deadlines.idleExpiresAt}, ${deadlines.hardExpiresAt}
    )
  `;
});

const seedFreshSession = (): ReturnType<typeof seedReplacementSession> =>
  seedReplacementSession({
    subjectUserId: userId,
    tokenBearer: bearer,
    sessionId: webSessionId,
    sessionBearer: webSessionBearer,
  });

const requestCandidate = (
  candidateEmail: string,
  cookie = sessionCookie
): ReturnType<typeof HttpClient.post> =>
  HttpClient.post("/email/replacement", {
    headers: { cookie, "content-type": "application/json" },
    body: HttpBody.jsonUnsafe({ candidateEmail }),
  });

const verifyCode = (
  combinedCode: string,
  cookie = sessionCookie
): ReturnType<typeof HttpClient.post> =>
  HttpClient.post("/web/email/replacement/verify", {
    headers: {
      cookie,
      origin: "https://fidyapp.com",
      "content-type": "application/json",
    },
    body: HttpBody.jsonUnsafe({ combinedCode }),
  });

// Select a fixture, then exercise the explicit-User finite Activity seam (not a second executor).
const processOneReplacementDelivery = Effect.fn(function* () {
  const sql = yield* MigrationSqlClient;
  const [payload] = yield* Schema.decodeUnknownEffect(Schema.Array(ReplacementDeliveryPayload))(
    yield* sql`SELECT intent.id AS "intentId", workflow.user_id AS "userId", 1 AS revision
      FROM email_replacement_delivery_intents intent
      JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
      WHERE workflow.user_id IN (${userId}, ${strangerUserId}) AND intent.status = 'pending'
      ORDER BY intent.created_at, intent.id LIMIT 1`.pipe(Effect.orDie)
  ).pipe(Effect.orDie);
  return payload === undefined
    ? false
    : (yield* performReplacementAttempt(payload, 1)) !== "not-current";
});

const processOneReplacementRetention = Effect.fn(function* () {
  const sql = yield* MigrationSqlClient;
  const [payload] = yield* Schema.decodeUnknownEffect(Schema.Array(ReplacementExpiryPayload))(
    yield* sql`SELECT id AS "workflowId", user_id AS "userId", 1 AS revision
      FROM email_replacement_workflows WHERE expires_at <= now() ORDER BY expires_at LIMIT 1`
  );
  return payload === undefined ? false : yield* expireReplacement(payload);
});

const captureNextDelivery = (): Effect.Effect<
  string,
  never,
  Crypto.Crypto | SqlClient.SqlClient | MigrationSqlClient
> =>
  Effect.gen(function* () {
    const code = yield* Ref.make(Option.none<string>());
    yield* processOneReplacementDelivery().pipe(
      Effect.provideService(
        EmailDeliveryPort,
        EmailDeliveryPort.of({
          send: ({ combinedCode }) => Ref.set(code, Option.some(combinedCode)),
        })
      )
    );
    return Option.getOrThrow(yield* Ref.get(code));
  });

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "verified email replacement",
  (it) => {
    it.effect(
      "keeps the old credential authoritative until fresh direct proof commits one swap event",
      () =>
        Effect.gen(function* () {
          yield* seedFreshSession();
          const sql = yield* MigrationSqlClient;
          yield* sql`UPDATE web_sessions SET paired_at = paired_at - interval '1 hour', fresh_until = fresh_until - interval '1 hour', hard_expires_at = hard_expires_at - interval '1 hour' WHERE id = ${webSessionId}`;
          const staleInitiation = yield* HttpClient.post("/email/replacement", {
            headers: { cookie: sessionCookie, "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({ candidateEmail: "never-admitted@example.com" }),
          });
          expect(staleInitiation.status).toBe(401);
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toEqual([]);
          expect(
            yield* sql`SELECT id FROM audit_log_entries WHERE user_id = ${userId} AND operation = 'emailAuthentication.requestEmailReplacement' AND outcome = 'succeeded'`
          ).toEqual([]);
          yield* sql`UPDATE web_sessions SET paired_at = paired_at + interval '1 hour', fresh_until = fresh_until + interval '1 hour', hard_expires_at = hard_expires_at + interval '1 hour' WHERE id = ${webSessionId}`;

          for (const [response, expectedStatus] of [
            [
              yield* HttpClient.post("/web/email/replacement/verify", {
                headers: {
                  cookie: sessionCookie,
                  origin: "https://attacker.example",
                  "content-type": "application/json",
                },
                body: HttpBody.jsonUnsafe({ combinedCode: "invalid" }),
              }),
              403,
            ],
            [
              yield* HttpClient.post("/web/email/replacement/verify", {
                headers: {
                  cookie: sessionCookie,
                  origin: "https://fidyapp.com",
                  "content-type": "text/plain",
                },
                body: HttpBody.text("invalid"),
              }),
              415,
            ],
            [
              yield* HttpClient.post("/web/email/replacement/verify", {
                headers: {
                  cookie: sessionCookie,
                  origin: "https://fidyapp.com",
                  "content-type": "application/jsonp",
                },
                body: HttpBody.text("invalid", "application/jsonp"),
              }),
              415,
            ],
            [
              yield* HttpClient.post("/web/email/replacement/verify", {
                headers: {
                  cookie: sessionCookie,
                  origin: "https://fidyapp.com",
                  "content-type": "application/json",
                },
                body: HttpBody.text("x".repeat(129), "application/json"),
              }),
              413,
            ],
          ] as const) {
            expect(response.status).toBe(expectedStatus);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(encodedBodySize(yield* response.json)).toBeLessThan(512);
          }

          const currentNoOp = yield* HttpClient.post("/email/replacement", {
            headers: { cookie: sessionCookie, "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({ candidateEmail: `seed-${userId}@fidyapp.com` }),
          });
          expect(currentNoOp.status).toBe(200);
          expect(yield* currentNoOp.json).toEqual({ data: { status: "pending" }, next: [] });
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toEqual([]);

          const requested = yield* HttpClient.post("/email/replacement", {
            headers: { cookie: sessionCookie, "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({ candidateEmail: "  New.Mailbox+Fidy@Example.COM " }),
          });
          expect(requested.status).toBe(200);
          expect(yield* requested.json).toEqual({ data: { status: "pending" }, next: [] });

          expect(
            yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
          ).toEqual([{ email_address: `seed-${userId}@fidyapp.com` }]);

          const deliveredCode = yield* Ref.make(Option.none<string>());
          expect(
            yield* processOneReplacementDelivery().pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({
                  send: ({ combinedCode, purpose }) =>
                    Effect.gen(function* () {
                      expect(purpose).toBe("credential-replacement");
                      expect(
                        yield* sql`
                          SELECT status FROM email_replacement_delivery_intents
                          WHERE workflow_id IN (
                            SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}
                          )
                        `.pipe(Effect.orDie)
                      ).toEqual([{ status: "armed" }]);
                      yield* Ref.set(deliveredCode, Option.some(combinedCode));
                    }),
                })
              )
            )
          ).toBe(true);
          const combinedCode = Option.getOrThrow(yield* Ref.get(deliveredCode));
          const slotsLocked = yield* Deferred.make<void>();
          const releaseSlots = yield* Deferred.make<void>();
          const slotHolder = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT slot FROM email_verification_admission_slots FOR UPDATE`;
                yield* Deferred.succeed(slotsLocked, undefined);
                yield* Deferred.await(releaseSlots);
              })
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(slotsLocked);
          const capacityRejected = yield* verifyCode(combinedCode);
          expect(capacityRejected.status).toBe(400);
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toHaveLength(1);
          yield* Deferred.succeed(releaseSlots, undefined);
          yield* Fiber.join(slotHolder);

          const wrongCode = `${combinedCode.slice(0, 10)}BCDF-GHJK-MNPQ-RSTW`;
          const wrong = yield* HttpClient.post("/web/email/replacement/verify", {
            headers: {
              cookie: sessionCookie,
              origin: "https://fidyapp.com",
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({ combinedCode: wrongCode }),
          });
          expect(wrong.status).toBe(400);
          expect(encodedBodySize(yield* wrong.json)).toBeLessThan(512);
          expect(
            yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
          ).toEqual([{ email_address: `seed-${userId}@fidyapp.com` }]);
          expect(
            yield* sql`SELECT id FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
          ).toEqual([]);

          yield* sql`
          UPDATE web_sessions SET paired_at = paired_at - interval '1 hour',
            fresh_until = fresh_until - interval '1 hour',
            hard_expires_at = hard_expires_at - interval '1 hour' WHERE id = ${webSessionId}
        `;
          const stale = yield* HttpClient.post("/web/email/replacement/verify", {
            headers: {
              cookie: sessionCookie,
              origin: "https://fidyapp.com",
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({ combinedCode }),
          });
          expect(stale.status).toBe(401);
          expect(stale.headers["cache-control"]).toBe("no-store");
          expect(encodedBodySize(yield* stale.json)).toBeLessThan(512);
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toHaveLength(1);
          yield* sql`
          UPDATE web_sessions SET paired_at = paired_at + interval '1 hour',
            fresh_until = fresh_until + interval '1 hour',
            hard_expires_at = hard_expires_at + interval '1 hour' WHERE id = ${webSessionId}
        `;

          yield* sql`
            INSERT INTO browser_login_pairings (
              id, public_code, verifier_digest, created_at, expires_at, last_accepted_poll_at
            ) VALUES (
              'f1d1a000-0000-4000-8000-000000000426', 'XXXX-XXXX', decode(repeat('00', 32), 'hex'),
              now(), now() + interval '10 minutes', now()
            )
          `;
          yield* sql`
            INSERT INTO browser_pairing_email_workflows (
              id, user_id, pairing_id, credential_verified_at, public_code, started_at,
              expires_at, delivery_generation, resend_available_at
            ) SELECT 'f1d1a000-0000-4000-8000-000000000427', user_id,
              'f1d1a000-0000-4000-8000-000000000426', verified_at, 'ABCD-EFGH', now(),
              now() + interval '10 minutes', 1, now()
            FROM verified_email_credentials WHERE user_id = ${userId}
          `;

          const completed = yield* HttpClient.post("/web/email/replacement/verify", {
            headers: {
              cookie: sessionCookie,
              origin: "https://fidyapp.com",
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({ combinedCode }),
          });
          expect(completed.status).toBe(200);
          expect(completed.headers["cache-control"]).toBe("no-store");
          const completedBody = yield* completed.json;
          expect(completedBody).toEqual({ status: "replaced" });
          expect(encodedBodySize(completedBody)).toBeLessThan(512);
          expect(
            yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
          ).toEqual([{ email_address: "new.mailbox+fidy@example.com" }]);
          expect(
            yield* sql`SELECT id FROM browser_pairing_email_workflows WHERE user_id = ${userId}`
          ).toEqual([]);
          expect(
            yield* sql`
            SELECT subject_user_id, authorizing_web_session_id, event_kind,
              count(*)::int AS count
            FROM verified_email_credential_lifecycle_events
            WHERE subject_user_id = ${userId}
            GROUP BY subject_user_id, authorizing_web_session_id, event_kind
          `
          ).toEqual([
            {
              subject_user_id: userId,
              authorizing_web_session_id: webSessionId,
              event_kind: "Replaced",
              count: 1,
            },
          ]);
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toEqual([]);
          const audit = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ outcome: Schema.String, count: Schema.Int }))
          )(
            yield* sql`
            SELECT outcome, count(*)::int AS count FROM audit_log_entries
            WHERE user_id = ${userId} AND operation = 'emailAuthentication.requestEmailReplacement'
              AND outcome = 'succeeded'
            GROUP BY outcome
          `
          );
          expect(audit).toEqual([{ outcome: "succeeded", count: 2 }]);

          const replay = yield* HttpClient.post("/web/email/replacement/verify", {
            headers: {
              cookie: sessionCookie,
              origin: "https://fidyapp.com",
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({ combinedCode }),
          });
          expect(replay.status).toBe(400);
          expect(replay.headers["cache-control"]).toBe("no-store");
          expect(encodedBodySize(yield* replay.json)).toBeLessThan(512);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
          ).toEqual([{ count: 1 }]);
        })
    );

    it.effect("bounds distinct-recipient requests by the stable User delivery budget", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        const now = yield* DateTime.now;
        const alternateDeadlines = calculateWebSessionDeadlines(now);
        const crypto = yield* Crypto.Crypto;
        const alternateDigest = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(alternateWebSessionBearer))
          .pipe(Effect.orDie);
        yield* sql`
          INSERT INTO web_sessions (
            id, user_id, bearer_digest, paired_at, fresh_until, idle_expires_at, hard_expires_at
          ) VALUES (
            ${alternateWebSessionId}, ${userId}, ${alternateDigest}, ${now},
            ${alternateDeadlines.freshUntil}, ${alternateDeadlines.idleExpiresAt},
            ${alternateDeadlines.hardExpiresAt}
          )
        `;
        const providerSends = yield* Ref.make(0);
        const processDelivery = processOneReplacementDelivery().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({ send: () => Ref.update(providerSends, (count) => count + 1) })
          )
        );

        for (let index = 0; index < maximumEmailDeliveryGenerations; index += 1) {
          const response = yield* requestCandidate(
            `budget-${index}@example.com`,
            index % 2 === 0 ? sessionCookie : alternateSessionCookie
          );
          expect(response.status).toBe(200);
          expect(yield* processDelivery).toBe(true);
          yield* sql`
            UPDATE email_replacement_workflows SET resend_available_at = now() - interval '1 second'
            WHERE user_id = ${userId}
          `;
        }

        const denied = yield* requestCandidate("budget-denied@example.com", alternateSessionCookie);
        expect(denied.status).toBe(200);
        expect(yield* processDelivery).toBe(false);
        expect(yield* Ref.get(providerSends)).toBe(maximumEmailDeliveryGenerations);
        expect(
          yield* sql`
            SELECT delivery_generation AS generation FROM email_replacement_workflows
            WHERE user_id = ${userId}
          `
        ).toEqual([{ generation: maximumEmailDeliveryGenerations }]);
        expect(
          yield* sql`
            SELECT count(*)::int AS count FROM email_replacement_delivery_intents intent
            JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
            WHERE workflow.user_id = ${userId}
          `
        ).toEqual([{ count: maximumEmailDeliveryGenerations }]);
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
      })
    );

    it.effect("shares the recipient delivery budget across distinct Users", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        yield* seedReplacementSession({
          subjectUserId: strangerUserId,
          tokenBearer: strangerBearer,
          sessionId: strangerWebSessionId,
          sessionBearer: strangerWebSessionBearer,
        });
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        const providerSends = yield* Ref.make(0);
        const processDelivery = processOneReplacementDelivery().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({ send: () => Ref.update(providerSends, (count) => count + 1) })
          )
        );
        const candidateEmail = "shared-recipient-budget@example.com";

        for (let index = 0; index < maximumEmailDeliveryGenerations; index += 1) {
          const subjectUserId = index % 2 === 0 ? userId : strangerUserId;
          const response = yield* requestCandidate(
            candidateEmail,
            index % 2 === 0 ? sessionCookie : strangerSessionCookie
          );
          expect(response.status).toBe(200);
          expect(yield* processDelivery).toBe(true);
          yield* sql`DELETE FROM email_replacement_workflows WHERE user_id = ${subjectUserId}`;
        }

        const denied = yield* requestCandidate(candidateEmail, strangerSessionCookie);
        expect(denied.status).toBe(200);
        expect(yield* processDelivery).toBe(false);
        expect(yield* Ref.get(providerSends)).toBe(maximumEmailDeliveryGenerations);
        expect(
          yield* sql`
            SELECT id FROM email_replacement_workflows
            WHERE user_id IN (${userId}, ${strangerUserId})
          `
        ).toEqual([]);
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
      })
    );

    it.effect("keeps queued delivery matched to its forced-RLS workflow owner", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        yield* seedReplacementSession({
          subjectUserId: strangerUserId,
          tokenBearer: strangerBearer,
          sessionId: strangerWebSessionId,
          sessionBearer: strangerWebSessionBearer,
        });
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        const owners = new Map([
          ["owner-matched@example.com", userId],
          ["stranger-matched@example.com", strangerUserId],
        ]);
        yield* requestCandidate("owner-matched@example.com");
        yield* requestCandidate("stranger-matched@example.com", strangerSessionCookie);
        const sent = yield* Ref.make(0);
        const processDelivery = processOneReplacementDelivery().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({
              send: ({ to }) =>
                Effect.gen(function* () {
                  const armed = yield* sql`
                    SELECT workflow.user_id, intent.email_address, intent.status
                    FROM email_replacement_delivery_intents intent
                    JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
                    WHERE intent.email_address = ${to}
                  `.pipe(Effect.orDie);
                  expect(armed).toEqual([
                    { user_id: owners.get(to), email_address: to, status: "armed" },
                  ]);
                  yield* Ref.set(sent, (yield* Ref.get(sent)) + 1);
                }),
            })
          )
        );
        expect(yield* processDelivery).toBe(true);
        expect(yield* processDelivery).toBe(true);
        expect(yield* Ref.get(sent)).toBe(2);
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
      })
    );

    it.effect(
      "rejects a wrong-User durable payload without sending, installing proof, or expiring another User's workflow",
      () =>
        Effect.gen(function* () {
          yield* seedFreshSession();
          yield* seedReplacementSession({
            subjectUserId: strangerUserId,
            tokenBearer: strangerBearer,
            sessionId: strangerWebSessionId,
            sessionBearer: strangerWebSessionBearer,
          });
          const sql = yield* MigrationSqlClient;
          yield* sql`DELETE FROM email_delivery_admission_budgets`;
          yield* requestCandidate("wrong-worker-owner@example.com");
          const [delivery] = yield* Schema.decodeUnknownEffect(
            Schema.Array(ReplacementDeliveryPayload)
          )(
            yield* sql`SELECT id AS "intentId", ${strangerUserId}::text AS "userId", 1 AS revision
            FROM email_replacement_delivery_intents`
          );
          const [expiry] = yield* Schema.decodeUnknownEffect(
            Schema.Array(ReplacementExpiryPayload)
          )(
            yield* sql`SELECT id AS "workflowId", ${strangerUserId}::text AS "userId", 1 AS revision
            FROM email_replacement_workflows WHERE user_id = ${userId}`
          );
          if (delivery === undefined || expiry === undefined) {
            return yield* Effect.die("expected work");
          }
          const calls = yield* Ref.make(0);
          expect(
            yield* performReplacementAttempt(delivery, 1).pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({ send: () => Ref.update(calls, (count) => count + 1) })
              )
            )
          ).toBe("not-current");
          expect(yield* Ref.get(calls)).toBe(0);
          yield* sql`UPDATE email_replacement_workflows SET started_at = started_at - interval '25 hours',
          expires_at = expires_at - interval '25 hours' WHERE user_id = ${userId}`;
          expect(yield* expireReplacement(expiry)).toBe(false);
          expect(
            yield* sql`SELECT user_id, proof_digest FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toEqual([{ user_id: userId, proof_digest: null }]);
        })
    );

    it.effect("deletes a workflow after the bounded wrong-proof allowance", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_replacement_workflows`;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* requestCandidate("wrong-proof-limit@example.com");
        expect(
          yield* sql`
            SELECT intent.status FROM email_replacement_delivery_intents intent
            JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
            WHERE workflow.user_id = ${userId}
          `
        ).toEqual([{ status: "pending" }]);
        const combinedCode = yield* captureNextDelivery();
        const wrongCode = `${combinedCode.slice(0, 10)}BCDF-GHJK-MNPQ-RSTW`;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          expect((yield* verifyCode(wrongCode)).status).toBe(400);
        }
        expect(
          yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toEqual([]);
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
      })
    );

    it.effect("replaces an expired workflow and rejects proof before delivery", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_replacement_workflows`;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* requestCandidate("expired-first@example.com");
        const [pending] = yield* sql`
          SELECT public_code FROM email_replacement_workflows WHERE user_id = ${userId}
        `;
        const pendingPublicCode = yield* Schema.decodeUnknownEffect(Schema.String)(
          pending?.public_code
        );
        expect((yield* verifyCode(`${pendingPublicCode}-AAAA-AAAA-AAAA-AAAA`)).status).toBe(400);
        yield* sql`
          UPDATE email_replacement_workflows SET
            started_at = started_at - interval '25 hours',
            expires_at = expires_at - interval '25 hours'
          WHERE user_id = ${userId}
        `;
        yield* requestCandidate("expired-second@example.com");
        expect(
          yield* sql`
            SELECT candidate_email_address FROM email_replacement_workflows
            WHERE user_id = ${userId}
          `
        ).toEqual([{ candidate_email_address: "expired-second@example.com" }]);
        yield* sql`DELETE FROM email_replacement_workflows WHERE user_id = ${userId}`;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
      })
    );

    it.effect("fails closed on a malformed production admission key", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const attempted = withUserTransaction(
          userId,
          admitEmailDeliveryInScope({
            requester: { _tag: "User", userId },
            recipient: EmailAddress.make("malformed-key@example.com"),
            attemptedAt: yield* DateTime.now,
          })
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: { NODE_ENV: "production", EMAIL_ADMISSION_HMAC_KEY: "malformed" },
            })
          ),
          Effect.exit
        );
        expect(Exit.isFailure(yield* attempted)).toBe(true);
      })
    );

    it.effect("keeps the credential lookup HMAC key out of persistence and outcomes", () =>
      Effect.gen(function* () {
        const secret = "a".repeat(64);
        const lookup = yield* emailCredentialLookupKey(
          EmailAddress.make("lookup-key@example.com")
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: { NODE_ENV: "production", EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY: secret },
            })
          )
        );
        expect(lookup).not.toContain(secret);
        const malformed = yield* emailCredentialLookupKey(
          EmailAddress.make("lookup-key@example.com")
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: { NODE_ENV: "production", EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY: "malformed" },
            })
          ),
          Effect.exit
        );
        expect(Exit.isFailure(malformed)).toBe(true);
      })
    );

    it.effect(
      "preserves uncertain proof without redelivery, supersedes old proofs, and rejects global duplicates",
      () =>
        Effect.gen(function* () {
          yield* seedFreshSession();
          yield* seedReplacementSession({
            subjectUserId: strangerUserId,
            tokenBearer: strangerBearer,
            sessionId: strangerWebSessionId,
            sessionBearer: strangerWebSessionBearer,
          });
          const sql = yield* MigrationSqlClient;
          yield* HttpClient.post("/email/replacement", {
            headers: { cookie: sessionCookie, "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({ candidateEmail: "first-generation@example.com" }),
          });
          const firstCode = yield* Ref.make(Option.none<string>());
          expect(
            yield* processOneReplacementDelivery().pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({
                  send: ({ combinedCode }) =>
                    Ref.set(firstCode, Option.some(combinedCode)).pipe(
                      Effect.andThen(
                        new EmailSendFailed({ certainty: "ambiguous", retryable: false })
                      )
                    ),
                })
              )
            )
          ).toBe(true);
          const armedDigest = yield* sql`
            SELECT proof_digest FROM email_replacement_workflows WHERE user_id = ${userId}
          `;
          const [payload] = yield* Schema.decodeUnknownEffect(
            Schema.Array(ReplacementDeliveryPayload)
          )(
            yield* sql`SELECT intent.id AS "intentId", workflow.user_id AS "userId", 1 AS revision
              FROM email_replacement_delivery_intents intent
              JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
              WHERE workflow.user_id = ${userId}`
          );
          if (payload === undefined) return yield* Effect.die("expected delivery");
          expect(
            yield* performReplacementAttempt(payload, 1).pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({
                  send: () => Effect.die("must not redeliver uncertain proof"),
                })
              )
            )
          ).toBe("uncertain");
          expect(
            yield* sql`
              SELECT status FROM email_replacement_delivery_intents WHERE workflow_id IN (
                SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}
              )
            `
          ).toEqual([{ status: "uncertain" }]);
          expect(
            yield* sql`SELECT proof_digest FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toEqual(armedDigest);
          yield* HttpClient.post("/email/replacement", {
            headers: { cookie: sessionCookie, "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({ candidateEmail: "second-generation@example.com" }),
          });
          const secondCode = yield* Ref.make(Option.none<string>());
          yield* processOneReplacementDelivery().pipe(
            Effect.provideService(
              EmailDeliveryPort,
              EmailDeliveryPort.of({
                send: ({ combinedCode }) => Ref.set(secondCode, Option.some(combinedCode)),
              })
            )
          );
          const verify = (combinedCode: string): ReturnType<typeof HttpClient.post> =>
            HttpClient.post("/web/email/replacement/verify", {
              headers: {
                cookie: sessionCookie,
                origin: "https://fidyapp.com",
                "content-type": "application/json",
              },
              body: HttpBody.jsonUnsafe({ combinedCode }),
            });
          expect((yield* verify(Option.getOrThrow(yield* Ref.get(firstCode)))).status).toBe(400);
          expect((yield* verify(Option.getOrThrow(yield* Ref.get(secondCode)))).status).toBe(200);

          const duplicate = yield* HttpClient.post("/email/replacement", {
            headers: { cookie: sessionCookie, "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({ candidateEmail: `seed-${strangerUserId}@fidyapp.com` }),
          });
          expect(duplicate.status).toBe(200);
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toEqual([]);
        })
    );

    it.effect(
      "replaying a recorded replacement delivery does not send or install another proof",
      () =>
        Effect.gen(function* () {
          yield* seedFreshSession();
          const sql = yield* MigrationSqlClient;
          yield* sql`DELETE FROM email_delivery_admission_budgets`;
          yield* requestCandidate("duplicate-delivery@example.com");
          const [payload] = yield* Schema.decodeUnknownEffect(
            Schema.Array(ReplacementDeliveryPayload)
          )(
            yield* sql`SELECT intent.id AS "intentId", workflow.user_id AS "userId", 1 AS revision
            FROM email_replacement_delivery_intents intent
            JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
            WHERE workflow.user_id = ${userId}`
          );
          if (payload === undefined) return yield* Effect.die("expected admitted delivery");
          const codes = yield* Ref.make<ReadonlyArray<string>>([]);
          const delivery = performReplacementAttempt(payload, 1).pipe(
            Effect.provideService(
              EmailDeliveryPort,
              EmailDeliveryPort.of({
                send: ({ combinedCode }) =>
                  Ref.update(codes, (values) => [...values, combinedCode]),
              })
            )
          );
          expect(yield* delivery).toBe("sent");
          expect(yield* delivery).toBe("sent");
          const sent = yield* Ref.get(codes);
          expect(sent).toHaveLength(1);
          expect((yield* verifyCode(sent[0] ?? "")).status).toBe(200);
        })
    );

    it.effect(
      "refuses stale credential work before sending and refuses stale settlement after provider I/O",
      () =>
        Effect.gen(function* () {
          yield* seedFreshSession();
          const sql = yield* MigrationSqlClient;
          yield* sql`DELETE FROM email_delivery_admission_budgets`;
          yield* requestCandidate("stale-provider-work@example.com");
          const [payload] = yield* Schema.decodeUnknownEffect(
            Schema.Array(ReplacementDeliveryPayload)
          )(
            yield* sql`SELECT intent.id AS "intentId", workflow.user_id AS "userId", 1 AS revision
            FROM email_replacement_delivery_intents intent JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
            WHERE workflow.user_id = ${userId}`
          );
          if (payload === undefined) return yield* Effect.die("expected delivery");
          yield* sql`UPDATE verified_email_credentials SET verified_at = verified_at + interval '1 second' WHERE user_id = ${userId}`;
          expect(
            yield* performReplacementAttempt(payload, 1).pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({
                  send: () => Effect.die("stale work must not reach provider"),
                })
              )
            )
          ).toBe("not-current");
          expect(
            yield* sql`SELECT proof_digest FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toEqual([{ proof_digest: null }]);
          yield* sql`UPDATE verified_email_credentials SET verified_at = verified_at - interval '1 second' WHERE user_id = ${userId}`;
          const code = yield* Ref.make(Option.none<string>());
          expect(
            yield* performReplacementAttempt(payload, 1).pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({
                  send: ({ combinedCode }) =>
                    Ref.set(code, Option.some(combinedCode)).pipe(
                      Effect.andThen(
                        sql`UPDATE verified_email_credentials SET verified_at = verified_at + interval '1 second'
              WHERE user_id = ${userId}`.pipe(Effect.orDie, Effect.asVoid)
                      )
                    ),
                })
              )
            )
          ).toBe("not-current");
          expect((yield* verifyCode(Option.getOrThrow(yield* Ref.get(code)))).status).toBe(400);
          expect(
            yield* sql`SELECT status FROM email_replacement_delivery_intents WHERE id = ${payload.intentId}`
          ).toEqual([{ status: "armed" }]);
          expect(
            yield* sql`SELECT id FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
          ).toEqual([]);
        })
    );

    it.effect("rejects a replacement proof pinned to an obsolete credential revision", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* requestCandidate("obsolete-replacement@example.com");
        const code = yield* captureNextDelivery();
        yield* sql`UPDATE verified_email_credentials SET verified_at = verified_at + interval '1 second'
          WHERE user_id = ${userId}`;
        expect((yield* verifyCode(code)).status).toBe(400);
        expect(
          yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
        ).toEqual([{ email_address: `seed-${userId}@fidyapp.com` }]);
        expect(
          yield* sql`SELECT id FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
        ).toEqual([]);
      })
    );

    it.effect("revalidates cached WebSession authority at the atomic completion boundary", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* HttpClient.post("/email/replacement", {
          headers: { cookie: sessionCookie, "content-type": "application/json" },
          body: HttpBody.jsonUnsafe({ candidateEmail: "revoked-boundary@example.com" }),
        });
        const deliveredCode = yield* Ref.make(Option.none<string>());
        yield* processOneReplacementDelivery().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({
              send: ({ combinedCode }) => Ref.set(deliveredCode, Option.some(combinedCode)),
            })
          )
        );
        const attemptedAt = yield* DateTime.now;
        yield* sql`UPDATE web_sessions SET revoked_at = ${attemptedAt} WHERE id = ${webSessionId}`;
        const result = yield* completeEmailReplacement({
          subjectUserId: userId,
          authorizingWebSessionId: webSessionId,
          attemptedAt,
          combinedCode: Redacted.make(
            EmailVerificationCode.make(Option.getOrThrow(yield* Ref.get(deliveredCode)))
          ),
        });
        expect(result).toBe("fresh-pairing-required");
        expect(
          yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
        ).toEqual([{ email_address: `seed-${userId}@fidyapp.com` }]);
        expect(
          yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toHaveLength(1);
        expect(
          yield* sql`SELECT id FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
        ).toEqual([]);
      })
    );

    it.effect(
      "rejects another User's valid proof without consuming or changing either credential",
      () =>
        Effect.gen(function* () {
          yield* seedFreshSession();
          const sql = yield* MigrationSqlClient;
          yield* HttpClient.post("/email/replacement", {
            headers: { cookie: sessionCookie, "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({ candidateEmail: "isolated.replacement@example.com" }),
          });
          const deliveredCode = yield* Ref.make(Option.none<string>());
          yield* processOneReplacementDelivery().pipe(
            Effect.provideService(
              EmailDeliveryPort,
              EmailDeliveryPort.of({
                send: ({ combinedCode }) => Ref.set(deliveredCode, Option.some(combinedCode)),
              })
            )
          );
          const combinedCode = Option.getOrThrow(yield* Ref.get(deliveredCode));
          yield* seedReplacementSession({
            subjectUserId: strangerUserId,
            tokenBearer: strangerBearer,
            sessionId: strangerWebSessionId,
            sessionBearer: strangerWebSessionBearer,
          });

          const rejected = yield* HttpClient.post("/web/email/replacement/verify", {
            headers: {
              cookie: strangerSessionCookie,
              origin: "https://fidyapp.com",
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({ combinedCode }),
          });
          expect(rejected.status).toBe(400);
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toHaveLength(1);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM verified_email_credential_lifecycle_events WHERE subject_user_id IN (${userId}, ${strangerUserId})`
          ).toEqual([{ count: 0 }]);
          expect(
            yield* sql`SELECT user_id, email_address FROM verified_email_credentials WHERE user_id IN (${userId}, ${strangerUserId}) ORDER BY user_id`
          ).toEqual([
            { user_id: userId, email_address: `seed-${userId}@fidyapp.com` },
            { user_id: strangerUserId, email_address: `seed-${strangerUserId}@fidyapp.com` },
          ]);
        })
    );

    it.effect("serializes both initiation/completion lock orders without partial replacement", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* seedFreshSession();
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* requestCandidate("first-lock-order@example.com");
        const firstCode = yield* captureNextDelivery();
        yield* sql`
          CREATE OR REPLACE FUNCTION fidy_test_delay_replacement_workflow_update()
          RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$;
          CREATE TRIGGER fidy_test_delay_replacement_workflow_update
          BEFORE UPDATE ON email_replacement_workflows
          FOR EACH ROW EXECUTE FUNCTION fidy_test_delay_replacement_workflow_update()
        `;
        const initiationFirst = yield* requestCandidate("initiation-wins@example.com").pipe(
          Effect.forkChild
        );
        yield* Effect.sleep("25 millis");
        const completionSecond = yield* verifyCode(firstCode).pipe(Effect.forkChild);
        expect((yield* Fiber.join(initiationFirst)).status).toBe(200);
        expect((yield* Fiber.join(completionSecond)).status).toBe(400);
        yield* sql`
          DROP TRIGGER fidy_test_delay_replacement_workflow_update
            ON email_replacement_workflows;
          DROP FUNCTION fidy_test_delay_replacement_workflow_update()
        `;
        expect(
          yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
        ).toEqual([{ email_address: `seed-${userId}@fidyapp.com` }]);
        expect(
          yield* sql`SELECT candidate_email_address FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toEqual([{ candidate_email_address: "initiation-wins@example.com" }]);

        yield* seedFreshSession();
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* requestCandidate("second-lock-order@example.com");
        const secondCode = yield* captureNextDelivery();
        yield* sql`
          CREATE OR REPLACE FUNCTION fidy_test_delay_replacement_credential_update()
          RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$;
          CREATE TRIGGER fidy_test_delay_replacement_credential_update
          BEFORE UPDATE ON verified_email_credentials
          FOR EACH ROW EXECUTE FUNCTION fidy_test_delay_replacement_credential_update()
        `;
        const completionFirst = yield* verifyCode(secondCode).pipe(Effect.forkChild);
        yield* Effect.sleep("25 millis");
        const initiationSecond = yield* requestCandidate("completion-wins@example.com").pipe(
          Effect.forkChild
        );
        expect((yield* Fiber.join(completionFirst)).status).toBe(200);
        expect((yield* Fiber.join(initiationSecond)).status).toBe(200);
        yield* sql`
          DROP TRIGGER fidy_test_delay_replacement_credential_update
            ON verified_email_credentials;
          DROP FUNCTION fidy_test_delay_replacement_credential_update()
        `;
        expect(
          yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
        ).toEqual([{ email_address: "second-lock-order@example.com" }]);
        expect(
          yield* sql`SELECT candidate_email_address FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toEqual([{ candidate_email_address: "completion-wins@example.com" }]);
      })
    );

    it.effect("serializes concurrent resends into one new delivery generation", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* requestCandidate("resend-race@example.com");
        yield* sql`
          UPDATE email_replacement_workflows SET resend_available_at = now() - interval '1 second'
          WHERE user_id = ${userId}
        `;
        const responses = yield* Effect.all(
          [
            requestCandidate("resend-race@example.com"),
            requestCandidate("resend-race@example.com"),
          ],
          { concurrency: 2 }
        );
        expect(responses.map(({ status }) => status)).toEqual([200, 200]);
        expect(
          yield* sql`
            SELECT delivery_generation FROM email_replacement_workflows WHERE user_id = ${userId}
          `
        ).toEqual([{ delivery_generation: 2 }]);
        expect(
          yield* sql`
            SELECT generation, status FROM email_replacement_delivery_intents
            WHERE workflow_id IN (
              SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}
            ) ORDER BY generation
          `
        ).toEqual([
          { generation: 1, status: "superseded" },
          { generation: 2, status: "pending" },
        ]);
      })
    );

    it.effect("rejects expired proof and gives concurrent completion exactly one winner", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        const requestCandidate = (candidateEmail: string): ReturnType<typeof HttpClient.post> =>
          HttpClient.post("/email/replacement", {
            headers: { cookie: sessionCookie, "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({ candidateEmail }),
          });
        const deliver = (): ReturnType<typeof captureNextDelivery> =>
          Effect.gen(function* () {
            const code = yield* Ref.make(Option.none<string>());
            yield* processOneReplacementDelivery().pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({
                  send: ({ combinedCode }) => Ref.set(code, Option.some(combinedCode)),
                })
              )
            );
            return Option.getOrThrow(yield* Ref.get(code));
          });
        const verify = (combinedCode: string): ReturnType<typeof HttpClient.post> =>
          HttpClient.post("/web/email/replacement/verify", {
            headers: {
              cookie: sessionCookie,
              origin: "https://fidyapp.com",
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({ combinedCode }),
          });

        yield* requestCandidate("expired-proof@example.com");
        const expiredCode = yield* deliver();
        yield* sql`
          UPDATE email_replacement_workflows SET proof_expires_at = now() - interval '1 second'
          WHERE user_id = ${userId}
        `;
        expect((yield* verify(expiredCode)).status).toBe(400);
        expect(
          yield* sql`SELECT id FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
        ).toEqual([]);

        yield* requestCandidate("concurrent-proof@example.com");
        const concurrentCode = yield* deliver();
        const responses = yield* Effect.all([verify(concurrentCode), verify(concurrentCode)], {
          concurrency: 2,
        });
        expect(responses.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
          200, 400,
        ]);
        expect(
          yield* sql`SELECT count(*)::int AS count FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
        ).toEqual([{ count: 1 }]);
        expect(
          yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toEqual([]);
      })
    );

    it.effect("settles delivery safely when completion commits during provider I/O", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* requestCandidate("delivery-completion-race@example.com");
        const sendEntered = yield* Deferred.make<void>();
        const releaseSend = yield* Deferred.make<void>();
        const deliveredCode = yield* Ref.make(Option.none<string>());
        const worker = yield* processOneReplacementDelivery().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({
              send: ({ combinedCode }) =>
                Effect.gen(function* () {
                  yield* Ref.set(deliveredCode, Option.some(combinedCode));
                  yield* Deferred.succeed(sendEntered, undefined);
                  yield* Deferred.await(releaseSend);
                }),
            })
          ),
          Effect.forkChild
        );
        yield* Deferred.await(sendEntered);
        expect((yield* verifyCode(Option.getOrThrow(yield* Ref.get(deliveredCode)))).status).toBe(
          200
        );
        yield* Deferred.succeed(releaseSend, undefined);
        expect(yield* Fiber.join(worker)).toBe(false);
        expect(
          yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toEqual([]);
        expect(
          yield* sql`SELECT count(*)::int AS count FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
        ).toEqual([{ count: 1 }]);
      })
    );

    it.effect("keeps retention and completion atomic when expiry races proof submission", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* requestCandidate("retention-completion-race@example.com");
        const combinedCode = yield* captureNextDelivery();
        yield* sql`
          UPDATE email_replacement_workflows SET
            started_at = started_at - interval '25 hours',
            expires_at = expires_at - interval '25 hours',
            proof_expires_at = expires_at - interval '25 hours'
          WHERE user_id = ${userId}
        `;
        const [, response] = yield* Effect.all(
          [processOneReplacementRetention(), verifyCode(combinedCode)],
          { concurrency: 2 }
        );
        expect(response.status).toBe(400);
        expect(
          yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toEqual([]);
        expect(
          yield* sql`SELECT id FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
        ).toEqual([]);
      })
    );

    it.effect(
      "rolls back when another credential wins candidate uniqueness during completion",
      () =>
        Effect.gen(function* () {
          yield* seedFreshSession();
          yield* seedReplacementSession({
            subjectUserId: strangerUserId,
            tokenBearer: strangerBearer,
            sessionId: strangerWebSessionId,
            sessionBearer: strangerWebSessionBearer,
          });
          const sql = yield* MigrationSqlClient;
          yield* sql`DELETE FROM email_delivery_admission_budgets`;
          yield* requestCandidate("completion-uniqueness-race@example.com");
          const combinedCode = yield* captureNextDelivery();
          yield* sql.unsafe(`
          CREATE OR REPLACE FUNCTION fidy_test_delay_owner_credential_update()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.user_id = '${userId}'::uuid THEN PERFORM pg_sleep(0.2); END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER fidy_test_delay_owner_credential_update
          BEFORE UPDATE ON verified_email_credentials
          FOR EACH ROW EXECUTE FUNCTION fidy_test_delay_owner_credential_update()
        `);
          const completion = yield* verifyCode(combinedCode).pipe(Effect.forkChild);
          yield* Effect.sleep("25 millis");
          yield* sql`
          UPDATE verified_email_credentials SET
            email_address = 'completion-uniqueness-race@example.com'
          WHERE user_id = ${strangerUserId}
        `;
          expect((yield* Fiber.join(completion)).status).toBe(400);
          yield* sql`
          DROP TRIGGER fidy_test_delay_owner_credential_update ON verified_email_credentials;
          DROP FUNCTION fidy_test_delay_owner_credential_update()
        `;
          expect(
            yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
          ).toEqual([{ email_address: `seed-${userId}@fidyapp.com` }]);
          expect(
            yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
          ).toHaveLength(1);
          expect(
            yield* sql`SELECT id FROM verified_email_credential_lifecycle_events WHERE subject_user_id = ${userId}`
          ).toEqual([]);
        })
    );

    it.effect("rolls back credential consumption when lifecycle evidence insertion fails", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* HttpClient.post("/email/replacement", {
          headers: { cookie: sessionCookie, "content-type": "application/json" },
          body: HttpBody.jsonUnsafe({ candidateEmail: "rollback-evidence@example.com" }),
        });
        const deliveredCode = yield* Ref.make(Option.none<string>());
        yield* processOneReplacementDelivery().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({
              send: ({ combinedCode }) => Ref.set(deliveredCode, Option.some(combinedCode)),
            })
          )
        );
        yield* sql`
          CREATE OR REPLACE FUNCTION fidy_test_reject_lifecycle_event() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test evidence failure'; END $$;
          CREATE TRIGGER fidy_test_reject_lifecycle_event
          BEFORE INSERT ON verified_email_credential_lifecycle_events
          FOR EACH ROW EXECUTE FUNCTION fidy_test_reject_lifecycle_event()
        `;
        const response = yield* HttpClient.post("/web/email/replacement/verify", {
          headers: {
            cookie: sessionCookie,
            origin: "https://fidyapp.com",
            "content-type": "application/json",
          },
          body: HttpBody.jsonUnsafe({
            combinedCode: Option.getOrThrow(yield* Ref.get(deliveredCode)),
          }),
        });
        expect(response.status).toBe(500);
        expect(
          yield* sql`SELECT email_address FROM verified_email_credentials WHERE user_id = ${userId}`
        ).toEqual([{ email_address: `seed-${userId}@fidyapp.com` }]);
        expect(
          yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toHaveLength(1);
        yield* sql`
          DROP TRIGGER fidy_test_reject_lifecycle_event
            ON verified_email_credential_lifecycle_events;
          DROP FUNCTION fidy_test_reject_lifecycle_event()
        `;
      })
    );

    it.effect("removes expired workflows through the exact User-scoped expiry operation", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_delivery_admission_budgets`;
        yield* HttpClient.post("/email/replacement", {
          headers: { cookie: sessionCookie, "content-type": "application/json" },
          body: HttpBody.jsonUnsafe({ candidateEmail: "expired.replacement@example.com" }),
        });
        yield* sql`
          UPDATE email_replacement_workflows SET
            started_at = started_at - interval '25 hours',
            expires_at = expires_at - interval '25 hours'
          WHERE user_id = ${userId}
        `;
        expect(yield* processOneReplacementRetention()).toBe(true);
        expect(
          yield* sql`SELECT id FROM email_replacement_workflows WHERE user_id = ${userId}`
        ).toEqual([]);
        expect(yield* processOneReplacementRetention()).toBe(false);
      })
    );

    it.effect("keeps lifecycle evidence append-only and applies the strict retention cutoff", () =>
      Effect.gen(function* () {
        yield* seedFreshSession();
        const sql = yield* MigrationSqlClient;
        const cutoff = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
        yield* sql`
          INSERT INTO verified_email_credential_lifecycle_events (
            id, subject_user_id, authorizing_web_session_id, occurred_at
          ) VALUES
            ('f1d1a000-0000-4000-8000-000000000331', ${userId}, ${webSessionId},
              ${DateTime.makeUnsafe("2025-12-31T23:59:59.999Z")}),
            ('f1d1a000-0000-4000-8000-000000000332', ${userId}, ${webSessionId}, ${cutoff}),
            ('f1d1a000-0000-4000-8000-000000000333', ${userId}, ${webSessionId},
              ${DateTime.makeUnsafe("2026-01-01T00:00:00.001Z")})
        `;
        const privileges = yield* sql`
          SELECT
            has_table_privilege('fidy_runtime', 'verified_email_credential_lifecycle_events', 'SELECT') AS can_select,
            has_table_privilege('fidy_runtime', 'verified_email_credential_lifecycle_events', 'INSERT') AS can_insert,
            has_table_privilege('fidy_runtime', 'verified_email_credential_lifecycle_events', 'UPDATE') AS can_update,
            has_table_privilege('fidy_runtime', 'verified_email_credential_lifecycle_events', 'DELETE') AS can_delete
        `;
        expect(privileges).toEqual([
          { can_select: true, can_insert: true, can_update: false, can_delete: false },
        ]);
        expect(
          yield* sql`
            SELECT count(*)::int AS count FROM pg_constraint
            WHERE conrelid = 'verified_email_credential_lifecycle_events'::regclass
              AND contype = 'f'
          `
        ).toEqual([{ count: 0 }]);

        yield* removeReplacementLifecycleEventsBefore(cutoff);
        expect(
          yield* sql`
            SELECT id FROM verified_email_credential_lifecycle_events
            WHERE subject_user_id = ${userId} ORDER BY occurred_at
          `
        ).toEqual([
          { id: "f1d1a000-0000-4000-8000-000000000332" },
          { id: "f1d1a000-0000-4000-8000-000000000333" },
        ]);
      })
    );
  }
);
