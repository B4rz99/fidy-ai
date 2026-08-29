import { expect, layer } from "@effect/vitest";
import { Webhook } from "svix";
import {
  BigDecimal,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { type SqlClient, SqlSchema, type Statement } from "effect/unstable/sql";
import { Money } from "~/core/_shared/money";
import { ConsentRecordId } from "~/core/consent/model";
import { makeColombianUser } from "~/core/identity/rules";
import { UserId } from "~/core/identity/reference";
import {
  ReceivedEmailContent,
  type ReceivedEmailContent as ReceivedEmailContentType,
} from "~/core/ingestion/model";
import { type TransactionExtraction } from "~/core/transactions/model";
import {
  IngestSampleId,
  ResendReceivedEmailId,
  type ResendReceivedEmailId as ResendReceivedEmailIdType,
} from "~/core/ingestion/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import {
  grantCurrentOnboardingConsentForTesting,
  revokeCurrentOnboardingConsentAtGateForTesting,
  revokeCurrentOnboardingConsentForTesting,
} from "~/shell/testing/consent";
import { upsertStableUserFixture } from "~/shell/testing/identity-fixtures";
import { testResendWebhookSecret } from "~/shell/testing/test-config";
import { ApprovedOperatorId, ForwardedEmailSampleApproval } from "./email-anonymization-approval";
import {
  NotificationEmailExtractionFailed,
  NotificationEmailExtractor,
  type NotificationEmailExtractorService,
} from "./email-extractor";
import { runEmailIngestRetention } from "./email-retention";
import { ForwardedEmailProcessor, forwardedEmailIngestion } from "./forwarded-email-ingestion";
import {
  ResendReceivingClient,
  type ResendReceivingClientService,
  ResendReceivingFailed,
} from "./resend-receiving-client";

const webhookSecret = testResendWebhookSecret;
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const getTestRow = <Result extends Schema.Constraint>(
  sql: SqlClient.SqlClient,
  Result: Result,
  statement: Statement.Statement<unknown>
): Effect.Effect<Result["Type"], never, Result["DecodingServices"]> =>
  SqlSchema.findOne({
    Request: Schema.Void,
    Result,
    execute: () => statement,
  })(undefined).pipe(Effect.orDie);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Email forwarding operations",
  (it) => {
    it.effect("enables one permanent address and securely admits durable authenticated work", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;
        const http = yield* HttpClient.HttpClient;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          TRUNCATE anonymized_email_ingest_samples, email_needs_review_items,
            raw_email_ingest_samples, source_attestations, forwarded_email_receipts,
            email_forwarding_addresses, forwarded_email_user_admission_windows,
            forwarded_email_known_admission_window, resend_webhook_deliveries,
            resend_webhook_admission_window
        `;

        const first = yield* client.ingestion.enableEmailForwarding();
        const second = yield* client.ingestion.enableEmailForwarding();
        const initialStatus = yield* client.ingestion.getEmailForwarding();
        expect(second.data).toEqual(first.data);
        expect(first.data.address).toMatch(/^[a-z0-9_-]{32}@ingest\.fidyapp\.com$/u);
        expect(Option.getOrThrow(initialStatus.data.address)).toEqual(first.data);
        expect(Option.isNone(initialStatus.data.remainingThisMonth)).toBe(true);
        expect(initialStatus.data.deferredEmails).toBe(0);
        expect(initialStatus.data.deferredCapacityRemaining).toBe(50);
        expect(yield* DateTime.isFuture(initialStatus.data.resetsAt)).toBe(true);

        const webhookNow = DateTime.toDateUtc(yield* DateTime.now);
        const makeDelivery = (
          id: string,
          recipient: string | ReadonlyArray<string>
        ): ReturnType<typeof http.post> => {
          const payload = encodeJson({
            type: "email.received",
            data: {
              email_id: id,
              to: typeof recipient === "string" ? [recipient] : recipient,
            },
          });
          const messageId = `msg_${id}`;
          return http.post("/webhooks/resend", {
            headers: {
              "svix-id": messageId,
              "svix-timestamp": String(Math.floor(webhookNow.getTime() / 1000)),
              "svix-signature": new Webhook(webhookSecret).sign(messageId, webhookNow, payload),
            },
            body: HttpBody.text(payload, "application/json"),
          });
        };

        const missingProof = yield* http.post("/webhooks/resend", {
          body: HttpBody.text("{}", "application/json"),
        });
        const missingTimestamp = yield* http.post("/webhooks/resend", {
          headers: { "svix-id": "missing-timestamp", "svix-signature": "v1,invalid" },
          body: HttpBody.text("{}", "application/json"),
        });
        const missingSignature = yield* http.post("/webhooks/resend", {
          headers: {
            "svix-id": "missing-signature",
            "svix-timestamp": String(Math.floor(webhookNow.getTime() / 1000)),
          },
          body: HttpBody.text("{}", "application/json"),
        });
        const malformedPayload = encodeJson({ type: "email.sent", data: {} });
        const malformedId = "msg_malformed";
        const malformed = yield* http.post("/webhooks/resend", {
          headers: {
            "svix-id": malformedId,
            "svix-timestamp": String(Math.floor(webhookNow.getTime() / 1000)),
            "svix-signature": new Webhook(webhookSecret).sign(
              malformedId,
              webhookNow,
              malformedPayload
            ),
          },
          body: HttpBody.text(malformedPayload, "application/json"),
        });
        const oversized = yield* http.post("/webhooks/resend", {
          body: HttpBody.text("x".repeat(65_537), "application/json"),
        });
        const stalledBody = yield* http
          .post("/webhooks/resend", {
            body: HttpBody.stream(Stream.never),
          })
          .pipe(Effect.timeout("2 seconds"));
        expect(missingProof.status).toBe(401);
        expect(missingTimestamp.status).toBe(401);
        expect(missingSignature.status).toBe(401);
        expect(malformed.status).toBe(400);
        expect(oversized.status).toBe(413);
        expect(stalledBody.status).toBe(429);

        const accepted = yield* makeDelivery("email_known_1", first.data.address);
        const replays = yield* Effect.forEach(
          Array.from({ length: 16 }),
          () => makeDelivery("email_known_1", first.data.address),
          { concurrency: 16 }
        );
        const unknown = yield* makeDelivery(
          "email_unknown_1",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@ingest.fidyapp.com"
        );
        const forged = yield* http.post("/webhooks/resend", {
          headers: {
            "svix-id": "msg_forged",
            "svix-timestamp": String(Math.floor(webhookNow.getTime() / 1000)),
            "svix-signature": "v1,invalid",
          },
          body: HttpBody.text(
            encodeJson({
              type: "email.received",
              data: { email_id: "email_forged", to: [first.data.address] },
            }),
            "application/json"
          ),
        });
        const row = yield* getTestRow(
          sql,
          Schema.Struct({
            deliveryCount: Schema.Int,
            forgedCount: Schema.Int,
            knownBudgetCount: Schema.Int,
            knownCount: Schema.Int,
            providerBudgetCount: Schema.Int,
            userBudgetCount: Schema.Int,
          }),
          sql`
          SELECT
            (SELECT count(*)::int FROM resend_webhook_deliveries) AS "deliveryCount",
            count(*) FILTER (WHERE received_email_id = 'email_forged')::int AS "forgedCount",
            (SELECT admitted_count::int FROM forwarded_email_known_admission_window
              WHERE singleton = true) AS "knownBudgetCount",
            count(*) FILTER (WHERE received_email_id = 'email_known_1')::int AS "knownCount",
            (SELECT admitted_count::int FROM resend_webhook_admission_window
              WHERE singleton = true) AS "providerBudgetCount",
            (SELECT admitted_count::int FROM forwarded_email_user_admission_windows
              WHERE user_id = ${defaultUserId}) AS "userBudgetCount"
          FROM forwarded_email_receipts
        `
        );

        expect(accepted.status).toBe(202);
        expect(replays.every((response) => response.status === 202)).toBe(true);
        expect(unknown.status).toBe(202);
        expect(yield* accepted.text).toBe(yield* unknown.text);
        expect(row).toEqual({
          deliveryCount: 2,
          forgedCount: 0,
          knownBudgetCount: 1,
          knownCount: 1,
          providerBudgetCount: 2,
          userBudgetCount: 1,
        });
        expect(forged.status).toBe(401);

        const receivedAt = DateTime.makeUnsafe("2020-01-02T02:00:00Z");
        const SuccessfulLanguageModel = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () =>
              Effect.succeed([
                {
                  type: "text" as const,
                  text: encodeJson({
                    money: { amount: "25000", currency: "COP" },
                    counterparty: "Comercio de prueba",
                    direction: "outflow",
                    occurredAt: DateTime.formatIso(receivedAt),
                  }),
                },
              ]),
            streamText: () => Stream.die(new Error("email extraction is non-streaming")),
          })
        );
        const extractor = Context.get(
          yield* Layer.build(
            NotificationEmailExtractor.layer.pipe(Layer.provide(SuccessfulLanguageModel))
          ),
          NotificationEmailExtractor
        );
        const processWith = Effect.fn("test.processForwardedEmailThroughInterface")(function* (
          provider: ResendReceivingClientService,
          usedExtractor: NotificationEmailExtractorService = extractor
        ) {
          const context = yield* Layer.build(
            ForwardedEmailProcessor.layer.pipe(
              Layer.provide(
                Layer.merge(
                  Layer.succeed(ResendReceivingClient, provider),
                  Layer.succeed(NotificationEmailExtractor, usedExtractor)
                )
              )
            )
          );
          yield* Context.get(context, ForwardedEmailProcessor).processNext;
        });
        const unavailable = ResendReceivingClient.of({
          retrieveEmail: () =>
            Effect.fail(new ResendReceivingFailed({ reason: "provider-unavailable" })),
        });
        yield* Effect.forEach([1, 2, 3], () => processWith(unavailable), {
          concurrency: 1,
          discard: true,
        });
        const review = yield* client.ingestion.listNeedsReviewItems({
          query: { offset: Option.none(), limit: Option.none() },
        });
        expect(review.data).toMatchObject([
          { reason: "provider-retrieval-failed", status: "pending" },
        ]);
        const emailReview = review.data.find((item) => item.sourceChannel === "forwarded-email");
        expect(
          emailReview?.sourceChannel === "forwarded-email" && emailReview.status === "pending"
            ? !("ingestSampleId" in emailReview)
            : false
        ).toBe(true);

        const providerContent = (
          receivedEmailId: ResendReceivedEmailIdType,
          to: ReadonlyArray<string>
        ): ReceivedEmailContentType =>
          ReceivedEmailContent.make({
            receivedEmailId,
            from: "alerts@example.test",
            to,
            subject: "Compra aprobada",
            text: Option.some("Compra por COP 25000"),
            html: Option.none(),
            inlineImages: [],
            messageId: Option.some("provider-message-success"),
            createdAt: receivedAt,
          });
        for (const mismatch of [
          {
            admittedId: "email_mismatched_id",
            returnedId: "email_other_user",
            to: [first.data.address],
          },
          {
            admittedId: "email_mismatched_recipient",
            returnedId: "email_mismatched_recipient",
            to: ["cccccccccccccccccccccccccccccccc@ingest.fidyapp.com"],
          },
        ]) {
          yield* makeDelivery(mismatch.admittedId, first.data.address);
          yield* processWith(
            ResendReceivingClient.of({
              retrieveEmail: () =>
                Effect.succeed(
                  providerContent(ResendReceivedEmailId.make(mismatch.returnedId), mismatch.to)
                ),
            })
          );
        }
        const mismatchEffects = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM raw_email_ingest_samples
          WHERE received_email_id IN ('email_mismatched_id', 'email_mismatched_recipient')
        `
        );
        expect(mismatchEffects.count).toBe(0);

        const successfulProvider = ResendReceivingClient.of({
          retrieveEmail: (receivedEmailId) =>
            Effect.succeed(providerContent(receivedEmailId, [first.data.address])),
        });
        yield* makeDelivery("email_model_failure", first.data.address);
        yield* processWith(
          successfulProvider,
          NotificationEmailExtractor.of({
            extract: () =>
              Effect.fail(new NotificationEmailExtractionFailed({ reason: "model-unavailable" })),
          })
        );
        const modelReview = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM email_needs_review_items
          WHERE received_email_id = 'email_model_failure' AND reason = 'model-unavailable'
        `
        );
        expect(modelReview.count).toBe(1);
        const modelReviewPage = yield* client.ingestion.listNeedsReviewItems({
          query: { offset: Option.none(), limit: Option.none() },
        });
        const visibleModelReview = modelReviewPage.data.find(
          (item) => item.sourceChannel === "forwarded-email" && item.reason === "model-unavailable"
        );
        expect(
          visibleModelReview?.sourceChannel === "forwarded-email" &&
            visibleModelReview.status === "pending"
            ? "ingestSampleId" in visibleModelReview
            : false
        ).toBe(true);

        const nonCanonicalExtraction: TransactionExtraction = {
          money: Money.make({
            amount: BigDecimal.fromStringUnsafe("0"),
            currency: "COP",
          }),
          counterparty: Option.none(),
          direction: "outflow",
          occurredAt: receivedAt,
        };
        yield* makeDelivery("email_canonical_failure", first.data.address);
        yield* processWith(
          successfulProvider,
          NotificationEmailExtractor.of({
            extract: () => Effect.succeed(nonCanonicalExtraction),
          })
        );
        const canonicalReview = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM email_needs_review_items
          WHERE received_email_id = 'email_canonical_failure'
            AND reason = 'canonical-validation-failed'
        `
        );
        expect(canonicalReview.count).toBe(1);

        yield* makeDelivery("email_success_1", first.data.address);
        yield* Effect.forEach(
          Array.from({ length: 10 }),
          () => processWith(successfulProvider).pipe(Effect.delay("10 millis")),
          { concurrency: 1, discard: true }
        );
        const captured = yield* getTestRow(
          sql,
          Schema.Struct({
            attestationCount: Schema.Int,
            receiptStatus: Schema.String,
            reviewReason: Schema.NullOr(Schema.String),
            transactionId: Schema.NullOr(Schema.String),
          }),
          sql`
          SELECT
            (SELECT count(*)::int FROM source_attestations
              WHERE kind = 'notification-email' AND received_email_id = 'email_success_1')
              AS "attestationCount",
            receipt.status AS "receiptStatus",
            review.reason AS "reviewReason",
            receipt.transaction_id::text AS "transactionId"
          FROM forwarded_email_receipts AS receipt
          LEFT JOIN email_needs_review_items AS review ON review.id = receipt.review_item_id
          WHERE receipt.received_email_id = 'email_success_1'
        `
        );
        expect(captured.attestationCount).toBe(1);
        expect(captured.receiptStatus).toBe("completed");
        expect(captured.reviewReason).toBeNull();
        expect(typeof captured.transactionId).toBe("string");

        const rawSample = yield* getTestRow(
          sql,
          Schema.Struct({ id: Schema.String }),
          sql`
          SELECT id::text AS id FROM raw_email_ingest_samples
          WHERE received_email_id = 'email_success_1'
        `
        );
        const approvedAt = yield* DateTime.now;
        const approvalContext = yield* Layer.build(ForwardedEmailSampleApproval.layer);
        const approval = Context.get(approvalContext, ForwardedEmailSampleApproval);
        expect(
          yield* approval.approve({
            sampleId: IngestSampleId.make(rawSample.id),
            approvedBy: ApprovedOperatorId.make("operator@example.test"),
          })
        ).toBe(true);
        const removed = yield* runEmailIngestRetention(DateTime.add(approvedAt, { days: 91 }));
        const retention = yield* getTestRow(
          sql,
          Schema.Struct({
            rawCount: Schema.Int,
            anonymizedCount: Schema.Int,
            leakedTextCount: Schema.Int,
          }),
          sql`
          SELECT
            (SELECT count(*)::int FROM raw_email_ingest_samples) AS "rawCount",
            (SELECT count(*)::int FROM anonymized_email_ingest_samples) AS "anonymizedCount",
            (SELECT count(*)::int FROM anonymized_email_ingest_samples
              WHERE structure LIKE '%Comercio%' OR structure LIKE '%25000%') AS "leakedTextCount"
        `
        );
        expect(removed).toBe(3);
        expect(retention).toEqual({ rawCount: 0, anonymizedCount: 1, leakedTextCount: 0 });
        const expiredReviewPage = yield* client.ingestion.listNeedsReviewItems({
          query: { offset: Option.none(), limit: Option.none() },
        });
        expect(
          expiredReviewPage.data.some(
            (item) =>
              item.sourceChannel === "forwarded-email" &&
              item.reason === "model-unavailable" &&
              item.status === "expired"
          )
        ).toBe(true);
        const tierTransitionUserId = UserId.make("f1d1a000-0000-4000-8000-00000000009d");
        yield* upsertStableUserFixture(
          tierTransitionUserId,
          yield* makeColombianUser(tierTransitionUserId, {
            paidTier: "pro",
            createdAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
          })
        );
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${tierTransitionUserId}`;
        yield* grantCurrentOnboardingConsentForTesting({
          sourceUserId: defaultUserId,
          subjectUserId: tierTransitionUserId,
          grantId: ConsentRecordId.make("f1d1a000-0000-4000-8000-00000000009e"),
        });
        const tierTransitionAddress = "dddddddddddddddddddddddddddddddd@ingest.fidyapp.com";
        yield* sql`
          INSERT INTO email_forwarding_addresses (user_id, local_part)
          VALUES (${tierTransitionUserId}, 'dddddddddddddddddddddddddddddddd')
        `;
        yield* Effect.forEach(
          [1, 2, 3],
          (number) => makeDelivery(`email_pro_${number}`, tierTransitionAddress),
          { concurrency: 1, discard: true }
        );
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${tierTransitionUserId}`;
        const transitionedStatus = yield* forwardedEmailIngestion.getStatus(tierTransitionUserId);
        expect(Option.getOrThrow(transitionedStatus.data.remainingThisMonth)).toBe(50);
        yield* sql`
          DELETE FROM forwarded_email_receipts WHERE user_id = ${tierTransitionUserId}
        `;

        const freeUserId = UserId.make("f1d1a000-0000-4000-8000-000000000099");
        yield* upsertStableUserFixture(
          freeUserId,
          yield* makeColombianUser(freeUserId, {
            paidTier: "free",
            createdAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
          })
        );
        yield* grantCurrentOnboardingConsentForTesting({
          sourceUserId: defaultUserId,
          subjectUserId: freeUserId,
          grantId: ConsentRecordId.make("f1d1a000-0000-4000-8000-00000000009a"),
        });
        const freeAddress = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@ingest.fidyapp.com";
        yield* sql`
          INSERT INTO email_forwarding_addresses (user_id, local_part)
          VALUES (${freeUserId}, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        `;
        const multiUserDelivery = yield* makeDelivery("email_multiple_known_users", [
          first.data.address,
          freeAddress,
        ]);
        const multiUserReceipt = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
          WHERE received_email_id = 'email_multiple_known_users'
        `
        );
        expect(multiUserDelivery.status).toBe(202);
        expect(multiUserReceipt.count).toBe(0);
        yield* Effect.forEach(
          Array.from({ length: 51 }, (_, index) => index + 1),
          (number) => makeDelivery(`email_quota_${number}`, freeAddress),
          { concurrency: 8, discard: true }
        );
        const quota = yield* getTestRow(
          sql,
          Schema.Struct({ queuedCount: Schema.Int, deferredCount: Schema.Int }),
          sql`
          SELECT
            count(*) FILTER (WHERE status = 'queued')::int AS "queuedCount",
            count(*) FILTER (WHERE status = 'deferred')::int AS "deferredCount"
          FROM forwarded_email_receipts WHERE user_id = ${freeUserId}
        `
        );
        expect(quota).toEqual({ queuedCount: 50, deferredCount: 1 });
        yield* sql`
          DELETE FROM forwarded_email_receipts
          WHERE user_id = ${freeUserId} AND status = 'queued'
        `;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${freeUserId}`;
        let promotedReceivedEmailId = "";
        yield* processWith(
          ResendReceivingClient.of({
            retrieveEmail: (receivedEmailId) => {
              promotedReceivedEmailId = receivedEmailId;
              return Effect.fail(new ResendReceivingFailed({ reason: "provider-unavailable" }));
            },
          })
        );
        expect(promotedReceivedEmailId).toMatch(/^email_quota_\d+$/u);
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${freeUserId}`;
        yield* sql`
          UPDATE forwarded_email_user_admission_windows
          SET window_start = date_trunc('hour', clock_timestamp()) + interval '1 hour',
            admitted_count = 99
          WHERE user_id = ${freeUserId}
        `;
        const burstResponses = yield* Effect.forEach(
          [1, 2],
          (number) => makeDelivery(`email_burst_${number}`, freeAddress),
          { concurrency: "unbounded" }
        );
        expect(
          burstResponses.map((response) => response.status).sort((left, right) => left - right)
        ).toEqual([202, 429]);
        const afterRateLimit = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
          WHERE user_id = ${freeUserId}
        `
        );
        expect(afterRateLimit.count).toBeLessThanOrEqual(51);

        const unknownBurst = yield* Effect.forEach(
          Array.from({ length: 40 }, (_, index) => index + 1),
          (number) =>
            makeDelivery(
              `email_unknown_burst_${number}`,
              `${String(number).padStart(24, "c")}@ingest.fidyapp.com`
            ),
          { concurrency: 1 }
        );
        expect(unknownBurst.every((response) => response.status === 202)).toBe(true);
        const unknownBurstReceipts = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
          WHERE received_email_id LIKE 'email_unknown_burst_%'
        `
        );
        expect(unknownBurstReceipts.count).toBe(0);

        yield* sql`
          UPDATE resend_webhook_admission_window
          SET window_start = date_trunc('minute', clock_timestamp()), admitted_count = 999
          WHERE singleton = true
        `;
        const authenticatedUnknownFlood = yield* Effect.forEach(
          [1, 2],
          (number) =>
            makeDelivery(
              `email_authenticated_unknown_flood_${number}`,
              "zzzzzzzzzzzzzzzzzzzzzzzz@ingest.fidyapp.com"
            ),
          { concurrency: "unbounded" }
        );
        expect(
          authenticatedUnknownFlood
            .map((response) => response.status)
            .sort((left, right) => left - right)
        ).toEqual([202, 429]);

        yield* sql`
          UPDATE resend_webhook_admission_window
          SET window_start = clock_timestamp() + interval '1 day', admitted_count = 1000
          WHERE singleton = true
        `;
        const skewedInstanceAttempt = yield* makeDelivery(
          "email_authenticated_future_window",
          "zzzzzzzzzzzzzzzzzzzzzzzz@ingest.fidyapp.com"
        );
        expect(skewedInstanceAttempt.status).toBe(429);
        const futureWindowBudget = yield* getTestRow(
          sql,
          Schema.Struct({ admittedCount: Schema.Int, remainsFuture: Schema.Boolean }),
          sql`
          SELECT admitted_count::int AS "admittedCount",
            window_start > clock_timestamp() AS "remainsFuture"
          FROM resend_webhook_admission_window
          WHERE singleton = true
        `
        );
        expect(futureWindowBudget).toEqual({ admittedCount: 1000, remainsFuture: true });
        const futureWindowReceipt = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
          WHERE received_email_id = 'email_authenticated_future_window'
        `
        );
        expect(futureWindowReceipt.count).toBe(0);

        const unauthenticatedFlood = yield* Effect.forEach(
          Array.from({ length: 16 }),
          () =>
            http.post("/webhooks/resend", {
              body: HttpBody.text("{}", "application/json"),
              headers: {
                "svix-id": "msg_unauthenticated_flood",
                "svix-timestamp": String(Math.floor(webhookNow.getTime() / 1000)),
                "svix-signature": "v1,invalid",
              },
            }),
          { concurrency: 8 }
        );
        expect(unauthenticatedFlood.every((response) => response.status === 401)).toBe(true);

        yield* revokeCurrentOnboardingConsentForTesting(
          freeUserId,
          ConsentRecordId.make("f1d1a000-0000-4000-8000-00000000009b")
        );
        let retrievalsAfterRevocation = 0;
        const postRevocationProvider = ResendReceivingClient.of({
          retrieveEmail: () => {
            retrievalsAfterRevocation += 1;
            return Effect.die("provider retrieval must not start after Consent revocation");
          },
        });
        yield* processWith(postRevocationProvider);
        const pendingAfterRevocation = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
          WHERE user_id = ${freeUserId} AND status IN ('queued', 'deferred', 'processing')
        `
        );
        expect(pendingAfterRevocation.count).toBe(0);
        expect(retrievalsAfterRevocation).toBe(0);
        expect(first.next).toEqual([]);
        expect(initialStatus.next).toEqual([]);
      })
    );

    it.effect("fences a stale worker from every effect after another claim completes", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`
          TRUNCATE anonymized_email_ingest_samples, email_needs_review_items,
            raw_email_ingest_samples, source_attestations, forwarded_email_receipts,
            email_forwarding_addresses, forwarded_email_user_admission_windows,
            forwarded_email_known_admission_window, resend_webhook_deliveries,
            resend_webhook_admission_window
        `;
        const localPart = "ffffffffffffffffffffffffffffffff";
        const address = `${localPart}@ingest.fidyapp.com`;
        const receivedEmailId = "email_stale_claim_fence";
        yield* sql`
          INSERT INTO email_forwarding_addresses (user_id, local_part)
          VALUES (${defaultUserId}, ${localPart})
        `;
        yield* sql`
          INSERT INTO forwarded_email_receipts (
            received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
            time_zone, period_start, consumes_free_allowance, admitted_at
          ) VALUES (
            ${receivedEmailId}, ${defaultUserId}, 'delivery-stale-claim-fence',
            'queued', 'CO', 'es-CO', 'America/Bogota', now(), true, now()
          )
        `;

        const content = ReceivedEmailContent.make({
          receivedEmailId: ResendReceivedEmailId.make(receivedEmailId),
          from: "alerts@example.test",
          to: [address],
          subject: "Compra aprobada",
          text: Option.some("Compra por COP 25000"),
          html: Option.none(),
          inlineImages: [],
          messageId: Option.some("provider-message-stale-claim"),
          createdAt: DateTime.makeUnsafe("2026-01-15T12:00:00Z"),
        });
        const extraction: TransactionExtraction = {
          money: Money.make({
            amount: BigDecimal.fromStringUnsafe("25000"),
            currency: "COP",
          }),
          counterparty: Option.some("Comercio"),
          direction: "outflow",
          occurredAt: DateTime.makeUnsafe("2026-01-15T12:00:00Z"),
        };
        const extractor = NotificationEmailExtractor.of({
          extract: () => Effect.succeed(extraction),
        });
        const processWith = Effect.fn("test.processStaleClaim")(function* (
          provider: ResendReceivingClientService
        ) {
          const context = yield* Layer.build(
            ForwardedEmailProcessor.layer.pipe(
              Layer.provide(
                Layer.merge(
                  Layer.succeed(ResendReceivingClient, provider),
                  Layer.succeed(NotificationEmailExtractor, extractor)
                )
              )
            )
          );
          yield* Context.get(context, ForwardedEmailProcessor).processNext;
        });

        const staleProviderStarted = yield* Deferred.make<void>();
        const releaseStaleProvider = yield* Deferred.make<void>();
        const staleWorker = yield* processWith(
          ResendReceivingClient.of({
            retrieveEmail: () =>
              Deferred.succeed(staleProviderStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStaleProvider)),
                Effect.as(content)
              ),
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(staleProviderStarted);
        yield* sql`
          UPDATE forwarded_email_receipts
          SET started_at = clock_timestamp() - interval '6 minutes'
          WHERE received_email_id = ${receivedEmailId} AND status = 'processing'
        `;
        const currentWorker = yield* processWith(
          ResendReceivingClient.of({ retrieveEmail: () => Effect.succeed(content) })
        ).pipe(Effect.forkChild);
        yield* Effect.sleep("50 millis");
        const replacement = yield* getTestRow(
          sql,
          Schema.Struct({ attemptCount: Schema.Int }),
          sql`
          SELECT attempt_count::int AS "attemptCount"
          FROM forwarded_email_receipts
          WHERE received_email_id = ${receivedEmailId}
        `
        );
        expect(replacement.attemptCount).toBe(2);
        yield* Deferred.succeed(releaseStaleProvider, undefined);
        yield* Fiber.join(staleWorker);
        yield* Fiber.join(currentWorker);

        const effects = yield* getTestRow(
          sql,
          Schema.Struct({
            attestationCount: Schema.Int,
            rawSampleCount: Schema.Int,
            receiptStatus: Schema.String,
            reviewCount: Schema.Int,
            transactionCount: Schema.Int,
          }),
          sql`
          SELECT
            (SELECT count(*)::int FROM source_attestations
              WHERE received_email_id = ${receivedEmailId}) AS "attestationCount",
            (SELECT count(*)::int FROM raw_email_ingest_samples
              WHERE received_email_id = ${receivedEmailId}) AS "rawSampleCount",
            receipt.status AS "receiptStatus",
            (SELECT count(*)::int FROM email_needs_review_items
              WHERE received_email_id = ${receivedEmailId}) AS "reviewCount",
            (SELECT count(*)::int FROM transactions
              WHERE id = receipt.transaction_id) AS "transactionCount"
          FROM forwarded_email_receipts AS receipt
          WHERE receipt.received_email_id = ${receivedEmailId}
        `
        );
        expect(effects).toEqual({
          attestationCount: 1,
          rawSampleCount: 1,
          receiptStatus: "completed",
          reviewCount: 0,
          transactionCount: 1,
        });

        const exhaustedId = "email_exhausted_stale_claim";
        yield* sql`
          INSERT INTO forwarded_email_receipts (
            received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
            time_zone, period_start, consumes_free_allowance, claim_id, attempt_count,
            admitted_at, started_at
          ) VALUES (
            ${exhaustedId}, ${defaultUserId}, 'delivery-exhausted-stale-claim',
            'processing', 'CO', 'es-CO', 'America/Bogota', now(), true,
            'f1d1a000-0000-4000-8000-00000000c203', 3, now(), now() - interval '6 minutes'
          )
        `;
        yield* processWith(
          ResendReceivingClient.of({
            retrieveEmail: () => Effect.die("exhausted work must not return to the provider"),
          })
        );
        const exhausted = yield* getTestRow(
          sql,
          Schema.Struct({
            outstandingCount: Schema.Int,
            reason: Schema.String,
            status: Schema.String,
          }),
          sql`
          SELECT receipt.status, review.reason,
            (SELECT count(*)::int FROM forwarded_email_receipts
              WHERE status IN ('queued', 'deferred', 'processing')) AS "outstandingCount"
          FROM forwarded_email_receipts AS receipt
          JOIN email_needs_review_items AS review ON review.id = receipt.review_item_id
          WHERE receipt.received_email_id = ${exhaustedId}
        `
        );
        expect(exhausted).toEqual({
          outstandingCount: 0,
          reason: "processing-interrupted",
          status: "completed",
        });
      })
    );

    it.effect("linearizes Consent revocation with external work and releases the gate", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`
          TRUNCATE anonymized_email_ingest_samples, email_needs_review_items,
            raw_email_ingest_samples, source_attestations, forwarded_email_receipts,
            email_forwarding_addresses, forwarded_email_user_admission_windows,
            forwarded_email_known_admission_window, resend_webhook_deliveries,
            resend_webhook_admission_window
        `;
        const extractor = NotificationEmailExtractor.of({
          extract: () => Effect.die("provider failure must stop before extraction"),
        });
        const processWith = Effect.fn("test.processConsentRace")(function* (
          provider: ResendReceivingClientService,
          usedExtractor: NotificationEmailExtractorService = extractor
        ) {
          const context = yield* Layer.build(
            ForwardedEmailProcessor.layer.pipe(
              Layer.provide(
                Layer.merge(
                  Layer.succeed(ResendReceivingClient, provider),
                  Layer.succeed(NotificationEmailExtractor, usedExtractor)
                )
              )
            )
          );
          yield* Context.get(context, ForwardedEmailProcessor).processNext;
        });
        const setup = Effect.fn("test.setupConsentRaceUser")(function* (input: {
          readonly userId: UserId;
          readonly localPart: string;
          readonly receivedEmailId: string;
        }) {
          yield* upsertStableUserFixture(
            input.userId,
            yield* makeColombianUser(input.userId, {
              paidTier: "free",
              createdAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
            })
          );
          yield* sql`
            INSERT INTO email_forwarding_addresses (user_id, local_part)
            VALUES (${input.userId}, ${input.localPart})
          `;
          yield* sql`
            INSERT INTO forwarded_email_receipts (
              received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
              time_zone, period_start, consumes_free_allowance, admitted_at
            ) VALUES (
              ${input.receivedEmailId}, ${input.userId}, ${`delivery-${input.receivedEmailId}`},
              'queued', 'CO', 'es-CO', 'America/Bogota', now(), true, now()
            )
          `;
        });

        const waitingUserId = UserId.make("f1d1a000-0000-4000-8000-0000000000a1");
        yield* setup({
          userId: waitingUserId,
          localPart: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          receivedEmailId: "email_external_work_wins",
        });
        const providerStarted = yield* Deferred.make<void>();
        const releaseProvider = yield* Deferred.make<void>();
        const processing = yield* processWith(
          ResendReceivingClient.of({
            retrieveEmail: () =>
              Deferred.succeed(providerStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseProvider)),
                Effect.andThen(
                  Effect.fail(new ResendReceivingFailed({ reason: "provider-unavailable" }))
                )
              ),
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(providerStarted);
        const revocationCompleted = yield* Deferred.make<void>();
        const revocation = yield* revokeCurrentOnboardingConsentForTesting(
          waitingUserId,
          ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000000a3")
        ).pipe(
          Effect.tap(() => Deferred.succeed(revocationCompleted, undefined)),
          Effect.forkChild
        );
        yield* Effect.sleep("25 millis");
        expect(yield* Deferred.isDone(revocationCompleted)).toBe(false);
        yield* Deferred.succeed(releaseProvider, undefined);
        yield* Fiber.join(processing);
        yield* Fiber.join(revocation);
        const workFirstOutcome = yield* getTestRow(
          sql,
          Schema.Struct({ revokedCount: Schema.Int, reviewCount: Schema.Int }),
          sql`
          SELECT
            (SELECT count(*)::int FROM forwarded_email_receipts
              WHERE user_id = ${waitingUserId} AND status = 'revoked') AS "revokedCount",
            (SELECT count(*)::int FROM email_needs_review_items
              WHERE user_id = ${waitingUserId}) AS "reviewCount"
        `
        );
        expect(workFirstOutcome).toEqual({ revokedCount: 1, reviewCount: 0 });

        const interruptedUserId = UserId.make("f1d1a000-0000-4000-8000-0000000000a4");
        yield* setup({
          userId: interruptedUserId,
          localPart: "ffffffffffffffffffffffffffffffff",
          receivedEmailId: "email_external_work_interrupted",
        });
        const interruptedStarted = yield* Deferred.make<void>();
        const interrupted = yield* processWith(
          ResendReceivingClient.of({
            retrieveEmail: () =>
              Deferred.succeed(interruptedStarted, undefined).pipe(Effect.andThen(Effect.never)),
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(interruptedStarted);
        yield* Fiber.interrupt(interrupted);
        const released = yield* revokeCurrentOnboardingConsentForTesting(
          interruptedUserId,
          ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000000a6")
        ).pipe(Effect.timeoutOption("1 second"));
        expect(Option.isSome(released)).toBe(true);

        yield* sql`DELETE FROM forwarded_email_receipts`;
        yield* sql`DELETE FROM email_forwarding_addresses`;
        const revocationFirstUserId = UserId.make("f1d1a000-0000-4000-8000-0000000000a7");
        yield* setup({
          userId: revocationFirstUserId,
          localPart: "dddddddddddddddddddddddddddddddd",
          receivedEmailId: "email_revocation_wins",
        });
        const gateAcquired = yield* Deferred.make<void>();
        const releaseRevocation = yield* Deferred.make<void>();
        const revocationFirst = yield* revokeCurrentOnboardingConsentAtGateForTesting({
          userId: revocationFirstUserId,
          revocationId: ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000000a9"),
          gateAcquired,
          releaseRevocation,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(gateAcquired);
        let providerCalls = 0;
        const revocationFirstProcessing = yield* processWith(
          ResendReceivingClient.of({
            retrieveEmail: () => {
              providerCalls += 1;
              return Effect.die("revocation-first work must not reach the provider");
            },
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseRevocation, undefined);
        yield* Fiber.join(revocationFirst);
        yield* Fiber.join(revocationFirstProcessing);
        const revocationFirstEffects = yield* getTestRow(
          sql,
          Schema.Struct({
            rawCount: Schema.Int,
            transactionCount: Schema.Int,
            revokedCount: Schema.Int,
          }),
          sql`
          SELECT
            (SELECT count(*)::int FROM raw_email_ingest_samples
              WHERE user_id = ${revocationFirstUserId}) AS "rawCount",
            (SELECT count(*)::int FROM transactions
              WHERE user_id = ${revocationFirstUserId}) AS "transactionCount",
            (SELECT count(*)::int FROM forwarded_email_receipts
              WHERE user_id = ${revocationFirstUserId} AND status = 'revoked') AS "revokedCount"
        `
        );
        expect(providerCalls).toBe(0);
        expect(revocationFirstEffects).toEqual({
          rawCount: 0,
          transactionCount: 0,
          revokedCount: 1,
        });
      })
    );

    it.effect("does not dispatch external work when no receipt is claimable", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`
          TRUNCATE anonymized_email_ingest_samples, email_needs_review_items,
            raw_email_ingest_samples, source_attestations, forwarded_email_receipts,
            email_forwarding_addresses, forwarded_email_user_admission_windows,
            forwarded_email_known_admission_window, resend_webhook_deliveries,
            resend_webhook_admission_window
        `;
        const context = yield* Layer.build(
          ForwardedEmailProcessor.layer.pipe(
            Layer.provide(
              Layer.merge(
                Layer.succeed(
                  ResendReceivingClient,
                  ResendReceivingClient.of({
                    retrieveEmail: () => Effect.die("idle processing must not retrieve email"),
                  })
                ),
                Layer.succeed(
                  NotificationEmailExtractor,
                  NotificationEmailExtractor.of({
                    extract: () => Effect.die("idle processing must not call the model"),
                  })
                )
              )
            )
          )
        );
        yield* Context.get(context, ForwardedEmailProcessor).processNext;
        const receipts = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
        `
        );
        expect(receipts.count).toBe(0);
      })
    );
  }
);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Forwarded email outstanding capacity",
  (it) => {
    it.effect("bounds Trial and Pro outstanding work without persisting overflow", () =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          TRUNCATE anonymized_email_ingest_samples, email_needs_review_items,
            raw_email_ingest_samples, source_attestations, forwarded_email_receipts,
            email_forwarding_addresses, forwarded_email_user_admission_windows,
            forwarded_email_known_admission_window, resend_webhook_deliveries,
            resend_webhook_admission_window
        `;
        const firstUserId = UserId.make("f1d1a000-0000-4000-8000-0000000000b1");
        const secondUserId = UserId.make("f1d1a000-0000-4000-8000-0000000000b3");
        for (const [userId, grantId] of [
          [firstUserId, ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000000b2")],
          [secondUserId, ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000000b4")],
        ] as const) {
          yield* upsertStableUserFixture(
            userId,
            yield* makeColombianUser(userId, {
              paidTier: "pro",
              createdAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
            })
          );
          yield* grantCurrentOnboardingConsentForTesting({
            sourceUserId: defaultUserId,
            subjectUserId: userId,
            grantId,
          });
        }
        const firstAddress = "99999999999999999999999999999999@ingest.fidyapp.com";
        const secondAddress = "88888888888888888888888888888888@ingest.fidyapp.com";
        yield* sql`
          INSERT INTO email_forwarding_addresses (user_id, local_part) VALUES
            (${firstUserId}, '99999999999999999999999999999999'),
            (${secondUserId}, '88888888888888888888888888888888')
        `;
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const deliver = (id: string, address: string): ReturnType<typeof http.post> => {
          const payload = encodeJson({
            type: "email.received",
            data: { email_id: id, to: [address] },
          });
          const messageId = `msg_${id}`;
          return http.post("/webhooks/resend", {
            headers: {
              "svix-id": messageId,
              "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
              "svix-signature": new Webhook(webhookSecret).sign(messageId, now, payload),
            },
            body: HttpBody.text(payload, "application/json"),
          });
        };
        yield* sql`
          INSERT INTO forwarded_email_receipts (
            received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
            time_zone, period_start, consumes_free_allowance, resume_at, admitted_at
          )
          SELECT
            'email_global_capacity_' || index::text,
            CASE WHEN index < 100 THEN ${firstUserId}::uuid ELSE ${secondUserId}::uuid END,
            'delivery_global_capacity_' || index::text,
            'queued', 'CO', 'es-CO', 'America/Bogota', now(), false,
            NULL, now()
          FROM generate_series(0, 198) AS index
        `;
        const beforeOverflow = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
          WHERE status IN ('queued', 'deferred', 'processing')
        `
        );
        expect(beforeOverflow.count).toBe(199);
        const concurrentOverflow = yield* Effect.all(
          [
            deliver("email_global_capacity_first", firstAddress),
            deliver("email_global_capacity_second", secondAddress),
          ],
          { concurrency: "unbounded" }
        );
        const stored = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
        `
        );
        expect(stored.count).toBe(200);
        expect(
          concurrentOverflow.map((response) => response.status).sort((left, right) => left - right)
        ).toEqual([202, 429]);

        const pendingIndex = concurrentOverflow.findIndex((response) => response.status === 429);
        const pendingDelivery = [
          ["email_global_capacity_first", firstAddress],
          ["email_global_capacity_second", secondAddress],
        ] as const;
        const pending = pendingDelivery[pendingIndex];
        expect(pending).toBeDefined();
        const budgetBeforeReplay = yield* getTestRow(
          sql,
          Schema.Struct({ known: Schema.Int, provider: Schema.Int, users: Schema.Int }),
          sql`
          SELECT
            (SELECT admitted_count::int FROM forwarded_email_known_admission_window
              WHERE singleton = true) AS known,
            (SELECT admitted_count::int FROM resend_webhook_admission_window
              WHERE singleton = true) AS provider,
            (SELECT coalesce(sum(admitted_count), 0)::int
              FROM forwarded_email_user_admission_windows) AS users
        `
        );
        const pendingReplays = yield* Effect.forEach(
          Array.from({ length: 16 }),
          () => deliver(pending?.[0] ?? "", pending?.[1] ?? ""),
          { concurrency: 16 }
        );
        const budgetAfterReplay = yield* getTestRow(
          sql,
          Schema.Struct({ known: Schema.Int, provider: Schema.Int, users: Schema.Int }),
          sql`
          SELECT
            (SELECT admitted_count::int FROM forwarded_email_known_admission_window
              WHERE singleton = true) AS known,
            (SELECT admitted_count::int FROM resend_webhook_admission_window
              WHERE singleton = true) AS provider,
            (SELECT coalesce(sum(admitted_count), 0)::int
              FROM forwarded_email_user_admission_windows) AS users
        `
        );
        expect(pendingReplays.every((response) => response.status === 429)).toBe(true);
        expect(budgetAfterReplay).toEqual(budgetBeforeReplay);
      })
    );
  }
);
