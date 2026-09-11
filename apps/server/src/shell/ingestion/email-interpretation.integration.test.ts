import { expect, layer } from "@effect/vitest";
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { ConsentRecordId } from "~/core/consent/model";
import { makeColombianUser } from "~/core/identity/rules";
import { UserId } from "~/core/identity/reference";
import { ReceivedEmailContent } from "~/core/ingestion/model";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultUserId } from "~/shell/db/development-seed";
import { grantCurrentOnboardingConsentForTesting } from "~/shell/testing/consent";
import { ForwardedEmailProcessor } from "./forwarded-email-ingestion";
import { publishForwardedEmailWorkflow } from "./forwarded-email-execution";
import { ResendReceivingClient } from "./resend-receiving-client";
import { ApiHarness } from "~/shell/testing/api-harness";
import { upsertStableUserFixture } from "~/shell/testing/identity-fixtures";
import { selectSourceAttestations } from "~/shell/transactions/reads";
import { TransactionId } from "~/core/transactions/reference";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "deterministic notification interpretation persistence",
  (it) => {
    it.effect("retains exact safe hints immutably and keeps them isolated to their User", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        const userId = UserId.make("f1d1a000-0000-4000-8000-000000000438");
        const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000439");
        for (const id of [userId, otherUserId]) {
          yield* upsertStableUserFixture(
            id,
            yield* makeColombianUser(id, {
              createdAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
            })
          );
        }
        yield* grantCurrentOnboardingConsentForTesting({
          sourceUserId: defaultUserId,
          subjectUserId: userId,
          grantId: ConsentRecordId.make("f1d1a000-0000-4000-8000-00000000043a"),
        });
        const localPart = "deterministic-notification-438";
        const receivedEmailId = ResendReceivedEmailId.make("email-deterministic-438");
        yield* sql`
          INSERT INTO email_forwarding_addresses (user_id, local_part)
          VALUES (${userId}, ${localPart})
          ON CONFLICT (user_id) DO UPDATE SET local_part = excluded.local_part
        `;
        yield* sql`
          INSERT INTO forwarded_email_receipts (
            received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
            time_zone, period_start, consumes_free_allowance, admitted_at
          ) VALUES (
            ${receivedEmailId}, ${userId}, 'delivery-deterministic-438', 'accepted', 'CO', 'es-CO',
            'America/Bogota', now(), true, now()
          )
        `;
        const html = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL(
              "./email-interpretation/formats/bbva-pse/fixtures/positive.synthetic.html",
              import.meta.url
            )
          ).text()
        ).pipe(Effect.orDie);
        let providerCalls = 0;
        const provider = ResendReceivingClient.of({
          retrieveEmail: (id) => {
            providerCalls += 1;
            return Effect.succeed(
              ReceivedEmailContent.make({
                receivedEmailId: id,
                from: "untrusted@example.test",
                to: [`${localPart}@ingest.fidyapp.com`],
                subject: "Untrusted subject",
                html: Option.some(html),
                text: Option.none(),
                inlineImages: [],
                messageId: Option.none(),
                createdAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
              })
            );
          },
        });
        yield* publishForwardedEmailWorkflow(userId, receivedEmailId);
        const processorContext = yield* Layer.build(
          ForwardedEmailProcessor.layer.pipe(
            Layer.provide(Layer.succeed(ResendReceivingClient, provider))
          )
        );
        const processor = Context.get(processorContext, ForwardedEmailProcessor);
        yield* processor.processNext;
        yield* processor.processNext;
        expect(providerCalls).toBe(1);

        const captured = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({ transactionId: Schema.String }),
          execute: () => sql`
            SELECT transaction_id::text AS "transactionId"
            FROM forwarded_email_receipts WHERE received_email_id = ${receivedEmailId}
          `,
        })(undefined).pipe(Effect.orDie);
        const transactionId = TransactionId.make(captured.transactionId);
        const attestations = yield* selectSourceAttestations(userId, transactionId);
        expect(attestations).toHaveLength(1);
        const attestation = attestations[0];
        expect(attestation?.kind).toBe("notification-email");
        if (attestation?.kind === "notification-email") {
          expect(attestation.extractorRevision).toBe("bbva-pse-v1");
          expect(attestation.deterministicInterpretation).toEqual(
            Option.some({
              formatId: "bbva-pse",
              currencyBasis: "format-cop-default-v1",
              accountHints: {
                cardLastFour: Option.none(),
                accountLastFour: Option.some("0012"),
                instrumentLabel: Option.none(),
              },
            })
          );
        }
        expect(yield* selectSourceAttestations(otherUserId, transactionId)).toEqual([]);

        const mutation = yield* Effect.result(sql`
          UPDATE source_attestations SET account_last_four = '9999'
          WHERE transaction_id = ${transactionId}
        `);
        expect(Result.isFailure(mutation)).toBe(true);

        const completeNumber = "4111111111111111";
        const unsafeReceivedEmailId = ResendReceivedEmailId.make("email-unsafe-438");
        yield* sql`
          INSERT INTO forwarded_email_receipts (
            received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
            time_zone, period_start, consumes_free_allowance, admitted_at
          ) VALUES (
            ${unsafeReceivedEmailId}, ${userId}, 'delivery-unsafe-438', 'accepted', 'CO', 'es-CO',
            'America/Bogota', now(), false, now()
          )
        `;
        yield* publishForwardedEmailWorkflow(userId, unsafeReceivedEmailId);
        const unsafeProvider = ResendReceivingClient.of({
          retrieveEmail: (id) =>
            Effect.succeed(
              ReceivedEmailContent.make({
                receivedEmailId: id,
                from: "untrusted@example.test",
                to: [`${localPart}@ingest.fidyapp.com`],
                subject: completeNumber,
                html: Option.some(html.replace("*0012", completeNumber)),
                text: Option.none(),
                inlineImages: [],
                messageId: Option.none(),
                createdAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
              })
            ),
        });
        const unsafeProcessor = yield* Layer.build(
          ForwardedEmailProcessor.layer.pipe(
            Layer.provide(Layer.succeed(ResendReceivingClient, unsafeProvider))
          )
        );
        yield* Context.get(unsafeProcessor, ForwardedEmailProcessor).processNext;
        const review = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({
            reason: Schema.String,
            issues: Schema.String,
            transactionId: Schema.OptionFromNullOr(Schema.String),
          }),
          execute: () => sql`
            SELECT review.reason, review.issues::text AS issues,
              receipt.transaction_id::text AS "transactionId"
            FROM forwarded_email_receipts receipt
            JOIN email_needs_review_items review ON review.id = receipt.review_item_id
            WHERE receipt.received_email_id = ${unsafeReceivedEmailId}
          `,
        })(undefined).pipe(Effect.orDie);
        expect(review).toMatchObject({ reason: "invalid-format", transactionId: Option.none() });
        expect(review.issues).not.toContain(completeNumber);
      })
    );
  }
);
