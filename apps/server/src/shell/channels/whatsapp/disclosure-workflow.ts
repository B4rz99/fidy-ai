import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { DurableDeferred, Workflow } from "effect/unstable/workflow";
import { PendingConsentExchangeId } from "~/core/consent/model";
import { DisclosureDeliveryAttemptId } from "./disclosure-model";

/** Identifier-only pre-User work. No User exists before verified onboarding completes. */
export const ConsentDisclosurePayload = Schema.Struct({
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  exchangeId: PendingConsentExchangeId,
}).annotate({ identifier: "ConsentDisclosurePayload" });
export type ConsentDisclosurePayload = typeof ConsentDisclosurePayload.Type;

/** Delivery is established by authenticated delivered/read evidence, never provider send acceptance. */
export const ConsentDisclosureSuccess = Schema.Struct({
  outcome: Schema.Literals(["delivered", "not-current"]),
});

/** One durable execution per eligible pending Consent exchange, independently of inbound redelivery. */
export const ConsentDisclosureWorkflow = Workflow.make("WhatsAppConsentDisclosureDelivery", {
  payload: ConsentDisclosurePayload,
  success: ConsentDisclosureSuccess,
  error: Schema.Never,
  idempotencyKey: ({ exchangeId }) => exchangeId,
});

/** Identifier-only evidence handoff, committed with Consent facts and completed outside SQL locks. */
export const ConsentDisclosureEvidencePayload = Schema.Struct({
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  exchangeId: PendingConsentExchangeId,
  attemptId: DisclosureDeliveryAttemptId,
  evidenceRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "ConsentDisclosureEvidencePayload" });
export type ConsentDisclosureEvidencePayload = typeof ConsentDisclosureEvidencePayload.Type;

export const consentDisclosureQueueName = "whatsapp-consent-disclosure";
export const consentDisclosureEvidenceQueueName = "whatsapp-consent-disclosure-evidence";

/** Transactional acceptance handoff using the shared SQL client; completion is not delivery evidence. */
export const consentDisclosureQueue = PersistedQueue.make({
  name: consentDisclosureQueueName,
  schema: ConsentDisclosurePayload,
});

/** Identifier-only evidence handoff, committed with Consent facts and completed outside SQL locks. */
export const consentDisclosureEvidenceQueue = PersistedQueue.make({
  name: consentDisclosureEvidenceQueueName,
  schema: ConsentDisclosureEvidencePayload,
});

const queueKeyHexLength = 32;

/** Bounded deterministic native queue key; source identifiers remain in the payload only. */
export const disclosureEvidenceQueueId = (input: {
  readonly attemptId: DisclosureDeliveryAttemptId;
  readonly evidenceRevision: number;
}): string =>
  createHash("sha256")
    .update(`${input.attemptId}/${input.evidenceRevision}`)
    .digest("hex")
    .slice(0, queueKeyHexLength);

/** One observation's wake-up: every effective evidence change completes the prior revision once. */
export const disclosureEvidenceChanged = (input: {
  readonly attemptId: DisclosureDeliveryAttemptId;
  readonly evidenceRevision: number;
}): DurableDeferred.DurableDeferred<typeof Schema.Void> =>
  DurableDeferred.make(`Evidence/${input.attemptId}/${input.evidenceRevision}`);
