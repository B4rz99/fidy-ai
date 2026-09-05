import { expect, layer } from "@effect/vitest";
import {
  BigDecimal,
  ConfigProvider,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/unstable/workflow";
import { Money } from "~/core/_shared/money";
import { ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { ReceivedEmailContent } from "~/core/ingestion/model";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  grantCurrentOnboardingConsentForTesting,
  revokeCurrentOnboardingConsentForTesting,
} from "~/shell/testing/consent";
import { upsertStableUserFixture } from "~/shell/testing/identity-fixtures";
import { NotificationEmailExtractor } from "./email-extractor";
import {
  ForwardedEmailQueueLive,
  ForwardedEmailWorkflow,
  ForwardedEmailWorkflowLive,
} from "./forwarded-email-workflow";
import { ResendReceivingClient } from "./resend-receiving-client";
import { forwardedEmailWorkflowQueue } from "./forwarded-email-execution";

const prepare = Effect.fn("test.prepareEmailRecovery")(function* () {
  const sql = yield* MigrationSqlClient;
  const crypto = yield* Crypto.Crypto;
  const userId = UserId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const receivedEmailId = ResendReceivedEmailId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const grantId = ConsentRecordId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const localPart = receivedEmailId.replaceAll("-", "");
  yield* upsertStableUserFixture(
    userId,
    yield* makeColombianUser(userId, { paidTier: "pro", createdAt: yield* DateTime.now })
  );
  yield* grantCurrentOnboardingConsentForTesting({
    sourceUserId: defaultUserId,
    subjectUserId: userId,
    grantId,
  });
  yield* sql`INSERT INTO email_forwarding_addresses (user_id, local_part) VALUES (${userId}, ${localPart})`;
  yield* sql`INSERT INTO forwarded_email_receipts (
    received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
    time_zone, period_start, consumes_free_allowance, admitted_at
  ) VALUES (${receivedEmailId}, ${userId}, ${receivedEmailId}, 'accepted', 'CO', 'es-CO',
    'America/Bogota', now(), false, now())`;
  return { sql, crypto, userId, receivedEmailId, grantId, localPart };
});

const recoveredQueueCount =
  (expected: number) =>
  (rows: ReadonlyArray<{ readonly count: number }>): boolean =>
    rows.some((row) => row.count === expected);
const hasDeferredReceipt = (rows: ReadonlyArray<{ readonly status: string }>): boolean =>
  rows.some((row) => row.status === "deferred");
const resolutionOutcomes = { restored: "completed", revoked: "revoked", absent: "stale" } as const;

const extraction = {
  money: Money.make({ amount: BigDecimal.fromStringUnsafe("25000"), currency: "COP" }),
  counterparty: Option.some("Recovery test"),
  direction: "outflow" as const,
  occurredAt: DateTime.makeUnsafe("2026-09-01T12:00:00Z"),
};

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Forwarded email recovery",
  (it) => {
    for (const mode of ["production-full", "production-empty", "development"] as const) {
      it.effect(
        `bounds ${mode} startup recovery and discards mismatched queue identities`,
        () =>
          Effect.gen(function* () {
            const sql = yield* MigrationSqlClient;
            yield* sql`TRUNCATE forwarded_email_interpretations, anonymized_email_ingest_samples,
            email_needs_review_items, raw_email_ingest_samples, source_attestations,
            forwarded_email_receipts, email_forwarding_addresses`;
            yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = 'forwarded-email-ingestion'`;
            const fixtures = yield* Effect.forEach(
              mode === "production-full" ? [1, 2, 3] : [],
              () => prepare()
            );
            const expectedCount = mode === "production-full" ? 103 : 0;
            if (mode === "production-full") {
              const first = Option.getOrThrow(Option.fromUndefinedOr(fixtures[0]));
              const queue = yield* forwardedEmailWorkflowQueue;
              yield* queue.offer(
                { userId: first.userId, receivedEmailId: first.receivedEmailId, revision: 1 },
                { id: "wrong-forwarded-email-queue-identity" }
              );
            }
            for (const { userId, receivedEmailId } of fixtures) {
              yield* sql`UPDATE forwarded_email_receipts SET status = 'deferred', resume_at = now() + interval '10 days' WHERE received_email_id = ${receivedEmailId}`;
              yield* sql`INSERT INTO forwarded_email_receipts (
        received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
        time_zone, period_start, consumes_free_allowance, admitted_at, resume_at
      ) SELECT ${receivedEmailId} || '-' || series, ${userId}, ${receivedEmailId} || '-' || series,
        'deferred', 'CO', 'es-CO', 'America/Bogota', now(), false, now(), now() + interval '10 days'
        FROM generate_series(1, 33) series`;
            }
            const runtime = ForwardedEmailWorkflowLive.pipe(
              Layer.provideMerge(WorkflowEngine.layerMemory),
              Layer.provide(
                Layer.succeed(
                  ResendReceivingClient,
                  ResendReceivingClient.of({
                    retrieveEmail: () => Effect.die("deferred work must not retrieve"),
                  })
                )
              ),
              Layer.provide(
                Layer.succeed(
                  NotificationEmailExtractor,
                  NotificationEmailExtractor.of({
                    extract: () => Effect.die("deferred work must not interpret"),
                  })
                )
              )
            );
            const context = yield* Layer.build(runtime.pipe(Layer.provideMerge(TestClock.layer())));
            const now = yield* DateTime.now;
            yield* Effect.gen(function* () {
              yield* TestClock.setTime(DateTime.toEpochMillis(now));
              yield* Layer.build(
                ForwardedEmailQueueLive.pipe(
                  Layer.provide(
                    ConfigProvider.layer(
                      ConfigProvider.fromEnv({
                        env: { NODE_ENV: mode === "development" ? "development" : "production" },
                      })
                    )
                  )
                )
              );
              yield* TestClock.adjust("2 minutes");
              const rows = yield* TestClock.withLive(
                sql`SELECT count(*)::int AS count FROM fidy_durable.fidy_queue WHERE queue_name = 'forwarded-email-ingestion' AND completed = true`.pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })))
                  ),
                  Effect.repeat({
                    until: recoveredQueueCount(expectedCount),
                    schedule: Schedule.spaced("10 millis"),
                  }),
                  Effect.timeout("10 seconds")
                )
              );
              expect(rows).toEqual([{ count: expectedCount }]);
            }).pipe(Effect.provide(context));
          }),
        20_000
      );
    }
    for (const phase of ["retrieval", "interpretation"] as const) {
      for (const transition of ["expired", "revoked", "absent", "defect"] as const) {
        if (phase === "retrieval" && transition === "absent") continue;
        it.effect(`reconciles ${transition} during ${phase} without repeating domain work`, () =>
          Effect.gen(function* () {
            const { sql, userId, receivedEmailId, localPart } = yield* prepare();
            const change = Effect.gen(function* () {
              if (transition === "defect") return yield* Effect.die("test provider defect");
              if (transition === "revoked" || transition === "expired") {
                yield* sql`UPDATE forwarded_email_receipts SET status = ${transition}, completed_at = now() WHERE received_email_id = ${receivedEmailId}`;
              } else {
                yield* sql`DELETE FROM raw_email_ingest_samples WHERE user_id = ${userId}`;
                yield* sql`DELETE FROM forwarded_email_receipts WHERE user_id = ${userId}`;
              }
            }).pipe(Effect.orDie);
            const provider = ResendReceivingClient.of({
              retrieveEmail: () =>
                Effect.gen(function* () {
                  if (phase === "retrieval") yield* change;
                  return ReceivedEmailContent.make({
                    receivedEmailId,
                    from: "alerts@example.test",
                    to: [`${localPart}@ingest.fidyapp.com`],
                    subject: "Compra",
                    text: Option.some("Compra"),
                    html: Option.none(),
                    inlineImages: [],
                    messageId: Option.none(),
                    createdAt: yield* DateTime.now,
                  });
                }),
            });
            const extractor = NotificationEmailExtractor.of({
              extract: () =>
                Effect.gen(function* () {
                  if (phase === "interpretation") yield* change;
                  return extraction;
                }),
            });
            const context = yield* Layer.build(
              ForwardedEmailWorkflowLive.pipe(
                Layer.provideMerge(WorkflowEngine.layerMemory),
                Layer.provide(Layer.succeed(ResendReceivingClient, provider)),
                Layer.provide(Layer.succeed(NotificationEmailExtractor, extractor))
              )
            );
            const result = yield* ForwardedEmailWorkflow.execute({
              userId,
              receivedEmailId,
              revision: 1,
            }).pipe(Effect.exit, Effect.provide(context));
            if (transition === "defect") {
              expect(result._tag).toBe("Failure");
            } else {
              expect(result).toMatchObject({
                _tag: "Success",
                value: { outcome: transition === "absent" ? "stale" : transition },
              });
            }
            expect(
              yield* sql`SELECT id FROM source_attestations WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})`
            ).toEqual([]);
          })
        );
      }
    }
    for (const phase of ["retrieval", "interpretation"] as const) {
      for (const resolution of ["restored", "revoked", "absent"] as const) {
        it.effect(
          `resumes ${phase} Consent deferral when the User becomes ${resolution}`,
          () =>
            Effect.gen(function* () {
              const fixture = yield* prepare();
              const { sql, userId, receivedEmailId, crypto, localPart } = fixture;
              const blocked = yield* Deferred.make<void>();
              let calls = 0;
              const loseConsent = Effect.gen(function* () {
                calls++;
                if (calls !== 1) return;
                yield* sql`UPDATE consent_records SET policy_revision = 'outdated-recovery-test' WHERE subject_user_id = ${userId}`.pipe(
                  Effect.orDie
                );
                yield* Deferred.succeed(blocked, undefined);
              });
              const provider = ResendReceivingClient.of({
                retrieveEmail: () =>
                  Effect.gen(function* () {
                    if (phase === "retrieval") yield* loseConsent;
                    return ReceivedEmailContent.make({
                      receivedEmailId,
                      from: "alerts@example.test",
                      to: [`${localPart}@ingest.fidyapp.com`],
                      subject: "Compra",
                      text: Option.some("Compra COP 25000"),
                      html: Option.none(),
                      inlineImages: [],
                      messageId: Option.none(),
                      createdAt: yield* DateTime.now,
                    });
                  }),
              });
              const extractor = NotificationEmailExtractor.of({
                extract: () =>
                  Effect.gen(function* () {
                    if (phase === "interpretation") yield* loseConsent;
                    return extraction;
                  }),
              });
              const runtime = ForwardedEmailWorkflowLive.pipe(
                Layer.provideMerge(WorkflowEngine.layerMemory),
                Layer.provide(Layer.succeed(ResendReceivingClient, provider)),
                Layer.provide(Layer.succeed(NotificationEmailExtractor, extractor))
              );
              const now = yield* DateTime.now;
              const context = yield* Layer.build(
                runtime.pipe(Layer.provideMerge(TestClock.layer()))
              );
              yield* Effect.gen(function* () {
                yield* TestClock.setTime(DateTime.toEpochMillis(now));
                const fiber = yield* ForwardedEmailWorkflow.execute({
                  userId,
                  receivedEmailId,
                  revision: 1,
                }).pipe(Effect.forkChild);
                yield* Deferred.await(blocked);
                yield* TestClock.withLive(
                  sql`SELECT status FROM forwarded_email_receipts WHERE received_email_id = ${receivedEmailId}`.pipe(
                    Effect.flatMap(
                      Schema.decodeUnknownEffect(
                        Schema.Array(Schema.Struct({ status: Schema.String }))
                      )
                    ),
                    Effect.repeat({
                      until: hasDeferredReceipt,
                      schedule: Schedule.spaced("10 millis"),
                    }),
                    Effect.timeout("5 seconds")
                  )
                );
                yield* TestClock.adjust("1 second");
                yield* sql`UPDATE consent_records SET policy_revision = (
                  SELECT policy_revision FROM consent_records WHERE subject_user_id = ${defaultUserId}
                  AND event_type = 'granted' ORDER BY occurred_at DESC LIMIT 1
                ) WHERE subject_user_id = ${userId}`;
                if (resolution === "revoked") {
                  yield* revokeCurrentOnboardingConsentForTesting(
                    userId,
                    ConsentRecordId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))
                  );
                }
                if (resolution === "absent") {
                  yield* sql`DELETE FROM raw_email_ingest_samples WHERE user_id = ${userId}`;
                  yield* sql`DELETE FROM forwarded_email_receipts WHERE user_id = ${userId}`;
                }
                yield* TestClock.adjust("2 days");
                expect(yield* Fiber.join(fiber)).toEqual({
                  outcome: resolutionOutcomes[resolution],
                });
              }).pipe(Effect.provide(context));
            }),
          20_000
        );
      }
    }
  }
);
