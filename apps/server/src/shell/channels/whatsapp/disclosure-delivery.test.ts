import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Ref, Schedule } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";
import { MigrationSqlClient } from "~/shell/db/client";
import { E164PhoneNumber } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { handleOnboardingTurn } from "~/shell/onboarding/onboarding";
import { findPendingConsentExchange, removePendingConsentExchange } from "~/shell/consent/repo";
import { ApiHarness } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import {
  ConsentDisclosureWorkflowLive,
  applyConsentDisclosureLifecycle,
  performConsentDisclosureAttempt,
  requestConsentDisclosureDelivery,
  startNextConsentDisclosureEvidence,
} from "./disclosure-delivery";
import { ConsentDisclosureWorkflow } from "./disclosure-workflow";
import { findConsentDisclosureDeliveryState } from "./disclosure-store";
import {
  DisclosureDeliveryAttemptNumber,
  DisclosureDeliveryCorrelationToken,
} from "./disclosure-model";
import { KapsoClient, type KapsoClientService, KapsoSendFailed } from "./kapso-client";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppMessageEvidence,
  WhatsAppProviderMessageId,
} from "./model";

const admit = Effect.fn(function* (phone: string) {
  const now = yield* DateTime.now;
  const caller = testWhatsAppCaller(E164PhoneNumber.make(phone));
  const previous = yield* findPendingConsentExchange(caller);
  if (Option.isSome(previous)) yield* removePendingConsentExchange(previous.value.id);
  const message = WhatsAppMessageEvidence.make({
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: WhatsAppProviderMessageId.make(`wamid.disclosure-${phone}`),
  });
  const admission = yield* handleOnboardingTurn({
    caller,
    content: { _tag: "Text", text: "Hola" },
    message,
    receivedAt: now,
  });
  if (admission._tag !== "SendDisclosure") return yield* Effect.die("expected disclosure");
  return {
    exchangeId: admission.exchangeId,
    event: {
      caller,
      messageEvidence: message,
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789012345"),
      content: { _tag: "Text" as const, text: TranscriptText.make("Hola") },
      occurredAt: now,
      receivedAt: now,
    },
    beforeProviderCall: Effect.void,
  };
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "durable Consent disclosure delivery",
  (it) => {
    it.effect(
      "acknowledges duplicate accepted work without invoking the provider in the request",
      () =>
        Effect.gen(function* () {
          const input = yield* admit("+573007774661");
          const calls = yield* Ref.make(0);
          const request = requestConsentDisclosureDelivery(input).pipe(
            Effect.provideService(KapsoClient, {
              sendText: () =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.andThen(
                    new KapsoSendFailed({
                      deliveryCertainty: "ambiguous",
                      safeReason: "timeout",
                      automaticRetry: false,
                      responseStatus: Option.none(),
                    })
                  )
                ),
            })
          );
          yield* request;
          yield* request;
          expect(yield* Ref.get(calls)).toBe(0);
        })
    );

    it.effect("rejects another pre-User exchange without accepting or sending its disclosure", () =>
      Effect.gen(function* () {
        const alice = yield* admit("+573007774662");
        const bob = yield* admit("+573007774663");
        const failure = yield* requestConsentDisclosureDelivery({
          ...bob,
          exchangeId: alice.exchangeId,
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("ConsentDisclosureDeliveryUnavailable");
        const calls = yield* Ref.make(0);
        yield* performConsentDisclosureAttempt(
          alice.exchangeId,
          DisclosureDeliveryAttemptNumber.make(1)
        ).pipe(
          Effect.provideService(KapsoClient, {
            sendText: () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(Effect.die("unaccepted disclosure was sent"))
              ),
          })
        );
        expect(yield* Ref.get(calls)).toBe(0);
      })
    );
    it.effect("rolls back delivered evidence and its wake when Consent refuses advancement", () =>
      Effect.gen(function* () {
        const input = yield* admit("+573007774666");
        yield* requestConsentDisclosureDelivery(input);
        const messageEvidence = {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: WhatsAppProviderMessageId.make("wamid.owner-refusal"),
        } as const;
        yield* performConsentDisclosureAttempt(
          input.exchangeId,
          DisclosureDeliveryAttemptNumber.make(1)
        ).pipe(
          Effect.provideService(KapsoClient, {
            sendText: () =>
              DateTime.now.pipe(
                Effect.map((sentAt) => ({
                  messageEvidence,
                  sentAt,
                  responseStatus: TelemetryHttpStatus.make(200),
                }))
              ),
          })
        );
        const before = yield* findConsentDisclosureDeliveryState(input.exchangeId).pipe(
          Effect.flatMap(Effect.fromOption)
        );
        const admin = yield* MigrationSqlClient;
        yield* admin`CREATE FUNCTION test_decline_disclosure_advancement() RETURNS trigger LANGUAGE plpgsql AS \$body\$ BEGIN RETURN NULL; END \$body\$;
        CREATE TRIGGER test_decline_disclosure_advancement BEFORE UPDATE ON pending_consent_exchanges
        FOR EACH ROW WHEN (OLD.id = ${admin.literal(`'${input.exchangeId}'::uuid`)} AND NEW.lifecycle = 'awaiting-decision') EXECUTE FUNCTION test_decline_disclosure_advancement()`;
        yield* Effect.addFinalizer(() =>
          admin`DROP TRIGGER test_decline_disclosure_advancement ON pending_consent_exchanges; DROP FUNCTION test_decline_disclosure_advancement()`.pipe(
            Effect.orDie
          )
        );
        const failure = yield* applyConsentDisclosureLifecycle({
          outcome: "accepted",
          correlationToken: DisclosureDeliveryCorrelationToken.make(before.attemptId),
          messageEvidence,
          occurredAt: yield* DateTime.now,
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("ConsentDisclosureDeliveryUnavailable");
        expect(yield* findConsentDisclosureDeliveryState(input.exchangeId)).toEqual(
          Option.some(before)
        );
        const wakes =
          yield* admin`SELECT id FROM fidy_durable.fidy_queue WHERE queue_name = 'whatsapp-consent-disclosure-evidence' AND element::jsonb->>'exchangeId' = ${input.exchangeId}`;
        expect(wakes).toHaveLength(0);
      })
    );

    it.effect("does not hand off or publish an expired disclosure request", () =>
      Effect.gen(function* () {
        const input = yield* admit("+573007774664");
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE pending_consent_exchanges SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE id = ${input.exchangeId}`;
        const handoffs = yield* Ref.make(0);
        yield* requestConsentDisclosureDelivery({
          ...input,
          beforeProviderCall: Ref.update(handoffs, (count) => count + 1),
        });
        expect(yield* Ref.get(handoffs)).toBe(0);
        const requests =
          yield* sql`SELECT exchange_id FROM whatsapp_consent_disclosure_requests WHERE exchange_id = ${input.exchangeId}`;
        expect(requests).toHaveLength(0);
        expect(Option.isNone(yield* findConsentDisclosureDeliveryState(input.exchangeId))).toBe(
          true
        );
      })
    );

    it.effect(
      "cancels a pending retry when authenticated sent evidence arrives before its clock",
      () =>
        Effect.gen(function* () {
          const input = yield* admit("+573007774665");
          yield* requestConsentDisclosureDelivery(input);
          const calls = yield* Ref.make(0);
          const provider: KapsoClientService = {
            sendText: () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(
                  new KapsoSendFailed({
                    deliveryCertainty: "rejected",
                    safeReason: "provider_unavailable",
                    automaticRetry: true,
                    responseStatus: Option.none(),
                  })
                )
              ),
          };
          const context = yield* Layer.build(
            ConsentDisclosureWorkflowLive.pipe(
              Layer.provide(Layer.succeed(KapsoClient, provider)),
              Layer.provideMerge(WorkflowEngine.layerMemory),
              Layer.fresh
            )
          );
          const payload = { exchangeId: input.exchangeId, revision: 1 } as const;
          yield* ConsentDisclosureWorkflow.execute(payload, { discard: true }).pipe(
            Effect.provideContext(context),
            Effect.provideService(KapsoClient, provider)
          );
          const executionId = yield* ConsentDisclosureWorkflow.executionId(payload);
          yield* ConsentDisclosureWorkflow.poll(executionId).pipe(
            Effect.provideContext(context),
            Effect.filterOrFail(
              (state) => Option.isSome(state) && state.value._tag === "Suspended"
            ),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
            Effect.orDie
          );
          const attempt = yield* findConsentDisclosureDeliveryState(input.exchangeId).pipe(
            Effect.flatMap(Effect.fromOption)
          );
          expect(attempt.state).toBe("definitively-failed");
          yield* startNextConsentDisclosureEvidence().pipe(
            Effect.forever,
            Effect.provideContext(context),
            Effect.provideService(KapsoClient, provider),
            Effect.forkScoped
          );
          expect(
            yield* applyConsentDisclosureLifecycle({
              outcome: "sent",
              correlationToken: DisclosureDeliveryCorrelationToken.make(attempt.attemptId),
              messageEvidence: {
                channel: "whatsapp",
                provider: "kapso",
                providerMessageId: WhatsAppProviderMessageId.make("wamid.retry-cancelled"),
              },
              occurredAt: yield* DateTime.now,
            })
          ).toBe("applied");
          // The original retry deadline is at most two seconds; no fresh send may follow it.
          yield* Effect.sleep("2200 millis");
          expect(yield* Ref.get(calls)).toBe(1);
          const latest = yield* findConsentDisclosureDeliveryState(input.exchangeId).pipe(
            Effect.flatMap(Effect.fromOption)
          );
          expect(latest.state).toBe("reconciliation-required");
        }),
      10_000
    );
  }
);
