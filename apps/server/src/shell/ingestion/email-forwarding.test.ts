import { UnknownJsonString } from "~/schema-compatibility";
import { expect, layer } from "@effect/vitest";
import { Webhook } from "svix";
import {
  BigDecimal,
  Context,
  Crypto,
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
import { publishForwardedEmailWorkflow } from "./forwarded-email-execution";
import { ForwardedEmailProcessor, forwardedEmailIngestion } from "./forwarded-email-ingestion";
import {
  ResendReceivingClient,
  type ResendReceivingClientService,
  ResendReceivingFailed,
} from "./resend-receiving-client";

const webhookSecret = testResendWebhookSecret;
const encodeJson = Schema.encodeSync(UnknownJsonString);

const cleanupForwardedEmailFixtures = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  yield* sql`
    TRUNCATE forwarded_email_interpretations, anonymized_email_ingest_samples,
      email_needs_review_items, raw_email_ingest_samples, source_attestations,
      forwarded_email_receipts, email_forwarding_addresses,
      forwarded_email_user_admission_windows, forwarded_email_known_admission_window,
      resend_webhook_deliveries, resend_webhook_admission_window
  `;
  yield* sql`DELETE FROM fidy_durable.fidy_queue
    WHERE queue_name = 'forwarded-email-ingestion'`;
});

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
        yield* cleanupForwardedEmailFixtures(sql);

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

        const dropRejectedOfferTrigger = Effect.gen(function* () {
          yield* sql`DROP TRIGGER IF EXISTS fidy_test_reject_forwarded_email_offer
            ON fidy_durable.fidy_queue`;
          yield* sql`DROP FUNCTION IF EXISTS fidy_test_reject_forwarded_email_offer()`;
        }).pipe(Effect.orDie);
        const rejectedOffer = yield* Effect.gen(function* () {
          yield* sql`
            CREATE FUNCTION fidy_test_reject_forwarded_email_offer()
            RETURNS trigger LANGUAGE plpgsql AS $function$
            BEGIN
              RAISE EXCEPTION 'test queue offer rejection';
            END
            $function$
          `;
          yield* sql`
            CREATE TRIGGER fidy_test_reject_forwarded_email_offer
            BEFORE INSERT ON fidy_durable.fidy_queue
            FOR EACH ROW WHEN (NEW.queue_name = 'forwarded-email-ingestion')
            EXECUTE FUNCTION fidy_test_reject_forwarded_email_offer()
          `;
          return yield* makeDelivery("email_known_1", first.data.address);
        }).pipe(Effect.ensuring(dropRejectedOfferTrigger));
        const rolledBackOffer = yield* getTestRow(
          sql,
          Schema.Struct({ queueCount: Schema.Int, receiptCount: Schema.Int }),
          sql`
            SELECT
              (SELECT count(*)::int FROM fidy_durable.fidy_queue
                WHERE queue_name = 'forwarded-email-ingestion') AS "queueCount",
              (SELECT count(*)::int FROM forwarded_email_receipts
                WHERE received_email_id = 'email_known_1') AS "receiptCount"
          `
        );
        expect(rejectedOffer.status).toBe(500);
        expect(rolledBackOffer).toEqual({ queueCount: 0, receiptCount: 0 });

        yield* sql`
          INSERT INTO fidy_durable.fidy_queue (
            id, queue_name, element, completed, attempts, created_at, updated_at
          ) VALUES (
            'malformed-forwarded-email-envelope', 'forwarded-email-ingestion', '{}',
            false, 0, now(), now()
          )
        `;
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
        let unavailableRetrievals = 0;
        const unavailable = ResendReceivingClient.of({
          retrieveEmail: () => {
            unavailableRetrievals += 1;
            return Effect.fail(new ResendReceivingFailed({ reason: "provider-unavailable" }));
          },
        });
        yield* processWith(unavailable);
        expect(unavailableRetrievals).toBe(3);
        expect(
          yield* getTestRow(
            sql,
            Schema.Struct({ attempts: Schema.Int, rejected: Schema.Boolean }),
            sql`
              SELECT attempts, last_failure IS NOT NULL AS rejected
              FROM fidy_durable.fidy_queue
              WHERE id = 'malformed-forwarded-email-envelope'
            `
          )
        ).toEqual({ attempts: 1, rejected: true });
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
        let invalidResponseRetrievals = 0;
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
              retrieveEmail: () => {
                invalidResponseRetrievals += 1;
                return Effect.succeed(
                  providerContent(ResendReceivedEmailId.make(mismatch.returnedId), mismatch.to)
                );
              },
            })
          );
        }
        expect(invalidResponseRetrievals).toBe(2);
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
        yield* processWith(successfulProvider);
        const captured = yield* getTestRow(
          sql,
          Schema.Struct({
            attestationCount: Schema.Int,
            receiptStatus: Schema.String,
            reviewReason: Schema.NullOr(Schema.String),
            transactionId: Schema.NullOr(Schema.String),
            categoryUserDecided: Schema.NullOr(Schema.Boolean),
            counterpartyUserDecided: Schema.NullOr(Schema.Boolean),
            notesUserDecided: Schema.NullOr(Schema.Boolean),
          }),
          sql`
          SELECT
            (SELECT count(*)::int FROM source_attestations
              WHERE kind = 'notification-email' AND received_email_id = 'email_success_1')
              AS "attestationCount",
            receipt.status AS "receiptStatus",
            review.reason AS "reviewReason",
            receipt.transaction_id::text AS "transactionId",
            transaction.category_user_decided AS "categoryUserDecided",
            transaction.counterparty_user_decided AS "counterpartyUserDecided",
            transaction.notes_user_decided AS "notesUserDecided"
          FROM forwarded_email_receipts AS receipt
          LEFT JOIN email_needs_review_items AS review ON review.id = receipt.review_item_id
          LEFT JOIN transactions AS transaction ON transaction.id = receipt.transaction_id
          WHERE receipt.received_email_id = 'email_success_1'
        `
        );
        expect(captured.attestationCount).toBe(1);
        expect(captured.receiptStatus).toBe("completed");
        expect(captured.reviewReason).toBeNull();
        expect(typeof captured.transactionId).toBe("string");
        expect(captured.categoryUserDecided).toBe(false);
        expect(captured.counterpartyUserDecided).toBe(false);
        expect(captured.notesUserDecided).toBe(false);

        const rawSample = yield* getTestRow(
          sql,
          Schema.Struct({ id: Schema.String }),
          sql`
          SELECT id::text AS id FROM raw_email_ingest_samples
          WHERE received_email_id = 'email_success_1'
        `
        );
        const approvedAt = yield* DateTime.now;
        yield* sql`
          INSERT INTO forwarded_email_receipts (
            received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
            time_zone, period_start, consumes_free_allowance, resume_at, admitted_at
          ) VALUES (
            'email_consent_deferred_expiry', ${defaultUserId},
            'delivery_consent_deferred_expiry', 'deferred', 'CO', 'es-CO',
            'America/Bogota', ${approvedAt}, true, ${DateTime.add(approvedAt, { days: 1 })},
            ${approvedAt}
          )
        `;
        const approvalContext = yield* Layer.build(ForwardedEmailSampleApproval.layer);
        const approval = Context.get(approvalContext, ForwardedEmailSampleApproval);
        expect(
          yield* approval.approve({
            sampleId: IngestSampleId.make(rawSample.id),
            approvedBy: ApprovedOperatorId.make("operator@example.test"),
          })
        ).toBe(true);
        yield* sql`
          UPDATE forwarded_email_receipts
          SET status = 'accepted', completed_at = NULL, review_item_id = NULL
          WHERE received_email_id IN ('email_model_failure', 'email_canonical_failure')
        `;
        yield* sql`
          INSERT INTO forwarded_email_interpretations (
            received_email_id, user_id, outcome, extraction, created_at, expires_at
          )
          SELECT receipt.received_email_id, receipt.user_id, 'model-unavailable', NULL,
            now(), sample.expires_at
          FROM forwarded_email_receipts AS receipt
          JOIN raw_email_ingest_samples AS sample
            ON sample.received_email_id = receipt.received_email_id
          WHERE receipt.received_email_id = 'email_model_failure'
        `;
        const removed = yield* runEmailIngestRetention(DateTime.add(approvedAt, { days: 91 }));
        const retention = yield* getTestRow(
          sql,
          Schema.Struct({
            rawCount: Schema.Int,
            anonymizedCount: Schema.Int,
            leakedTextCount: Schema.Int,
            interpretationCount: Schema.Int,
            deferredReceiptStatus: Schema.String,
            uninterpretedReceiptStatus: Schema.String,
            noSampleReceiptStatus: Schema.String,
          }),
          sql`
          SELECT
            (SELECT count(*)::int FROM raw_email_ingest_samples) AS "rawCount",
            (SELECT count(*)::int FROM anonymized_email_ingest_samples) AS "anonymizedCount",
            (SELECT count(*)::int FROM anonymized_email_ingest_samples
              WHERE structure LIKE '%Comercio%' OR structure LIKE '%25000%') AS "leakedTextCount",
            (SELECT count(*)::int FROM forwarded_email_interpretations)
              AS "interpretationCount",
            (SELECT status FROM forwarded_email_receipts
              WHERE received_email_id = 'email_model_failure') AS "deferredReceiptStatus",
            (SELECT status FROM forwarded_email_receipts
              WHERE received_email_id = 'email_canonical_failure') AS "uninterpretedReceiptStatus",
            (SELECT status FROM forwarded_email_receipts
              WHERE received_email_id = 'email_consent_deferred_expiry') AS "noSampleReceiptStatus"
        `
        );
        expect(removed).toBe(3);
        expect(retention).toEqual({
          rawCount: 0,
          anonymizedCount: 1,
          leakedTextCount: 0,
          interpretationCount: 0,
          deferredReceiptStatus: "accepted",
          uninterpretedReceiptStatus: "accepted",
          noSampleReceiptStatus: "deferred",
        });
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
        yield* sql`
          DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = 'forwarded-email-ingestion'
          AND element::jsonb->>'receivedEmailId' LIKE 'email_pro_%'
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
        yield* sql`
          INSERT INTO forwarded_email_receipts (
            received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
            time_zone, period_start, consumes_free_allowance, admitted_at
          )
          SELECT 'email_quota_' || index::text, ${freeUserId},
            'delivery_quota_' || index::text, 'accepted', 'CO', 'es-CO', 'America/Bogota',
            clock_timestamp(), true, clock_timestamp()
          FROM generate_series(1, 49) AS index
        `;
        const boundaryQuotaResponses = yield* Effect.forEach(
          [50, 51],
          (number) => makeDelivery(`email_quota_${number}`, freeAddress),
          { concurrency: "unbounded" }
        );
        expect(boundaryQuotaResponses.every((response) => response.status === 202)).toBe(true);
        const quota = yield* getTestRow(
          sql,
          Schema.Struct({ queuedCount: Schema.Int, deferredCount: Schema.Int }),
          sql`
          SELECT
            count(*) FILTER (WHERE status = 'accepted')::int AS "queuedCount",
            count(*) FILTER (WHERE status = 'deferred')::int AS "deferredCount"
          FROM forwarded_email_receipts WHERE user_id = ${freeUserId}
        `
        );
        expect(quota).toEqual({ queuedCount: 50, deferredCount: 1 });
        yield* sql`
          DELETE FROM forwarded_email_receipts
          WHERE user_id = ${freeUserId} AND status = 'accepted'
        `;
        yield* sql`
          DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = 'forwarded-email-ingestion'
          AND element::jsonb->>'receivedEmailId' = 'email_quota_50'
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
          WHERE user_id = ${freeUserId} AND status IN ('accepted', 'deferred')
        `
        );
        expect(pendingAfterRevocation.count).toBe(0);
        expect(retrievalsAfterRevocation).toBe(0);
        expect(first.next).toEqual([]);
        expect(initialStatus.next).toEqual([]);
      })
    );

    it.effect(
      "linearizes Consent revocation with external work and releases the gate",
      () =>
        Effect.gen(function* () {
          const sql = yield* MigrationSqlClient;
          yield* cleanupForwardedEmailFixtures(sql);
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
            const crypto = yield* Crypto.Crypto;
            yield* grantCurrentOnboardingConsentForTesting({
              sourceUserId: defaultUserId,
              subjectUserId: input.userId,
              grantId: ConsentRecordId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
            });
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
              'accepted', 'CO', 'es-CO', 'America/Bogota', now(), true, now()
            )
          `;
            yield* publishForwardedEmailWorkflow(
              input.userId,
              ResendReceivedEmailId.make(input.receivedEmailId)
            );
          });

          const crypto = yield* Crypto.Crypto;
          const waitingUserId = UserId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
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

          const interruptedUserId = UserId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
          yield* setup({
            userId: interruptedUserId,
            localPart: "ffffffffffffffffffffffffffffffff",
            receivedEmailId: "email_external_work_interrupted",
          });
          const interruptedStarted = yield* Deferred.make<void>();
          const releaseInterrupted = yield* Deferred.make<void>();
          const interrupted = yield* processWith(
            ResendReceivingClient.of({
              retrieveEmail: () =>
                Deferred.succeed(interruptedStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseInterrupted)),
                  Effect.andThen(
                    Effect.fail(new ResendReceivingFailed({ reason: "provider-unavailable" }))
                  )
                ),
            })
          ).pipe(Effect.forkChild);
          yield* Deferred.await(interruptedStarted);
          yield* Fiber.interrupt(interrupted);
          yield* Deferred.succeed(releaseInterrupted, undefined);
          const released = yield* revokeCurrentOnboardingConsentForTesting(
            interruptedUserId,
            ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000000a6")
          ).pipe(Effect.timeoutOption("1 second"));
          expect(Option.isSome(released)).toBe(true);

          yield* sql`DELETE FROM forwarded_email_receipts`;
          yield* sql`DELETE FROM email_forwarding_addresses`;
          const revocationFirstUserId = UserId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
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
        }),
      30_000
    );

    it.effect("does not dispatch external work when no receipt is claimable", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* cleanupForwardedEmailFixtures(sql);
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
        yield* cleanupForwardedEmailFixtures(sql);
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
            'accepted', 'CO', 'es-CO', 'America/Bogota', now(), false,
            NULL, now()
          FROM generate_series(0, 198) AS index
        `;
        const beforeOverflow = yield* getTestRow(
          sql,
          Schema.Struct({ count: Schema.Int }),
          sql`
          SELECT count(*)::int AS count FROM forwarded_email_receipts
          WHERE status IN ('accepted', 'deferred')
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
