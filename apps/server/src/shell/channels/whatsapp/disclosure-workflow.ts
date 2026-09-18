import { Crypto, Effect, Encoding, Schema } from "effect";
import { DurableDeferred, Workflow } from "effect/unstable/workflow";
import { PendingConsentExchangeId } from "~/core/consent/model";
import { declarePersistedQueue } from "~/shell/persisted-queue/operations";
import { DisclosureDeliveryAttemptId, type DisclosureRevision } from "./disclosure-model";

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
export const consentDisclosureQueue = declarePersistedQueue({
  name: consentDisclosureQueueName,
  schema: ConsentDisclosurePayload,
  descriptor: { component: "whatsapp", operation: "whatsapp.disclosureStart" },
});

/** Stable native queue key from one offered payload; the exchange identity stays in the payload. */
export const consentDisclosureQueueId = (payload: ConsentDisclosurePayload): string =>
  payload.exchangeId;

/** Identifier-only evidence handoff, committed with Consent facts and completed outside SQL locks. */
export const consentDisclosureEvidenceQueue = declarePersistedQueue({
  name: consentDisclosureEvidenceQueueName,
  schema: ConsentDisclosureEvidencePayload,
  descriptor: { component: "whatsapp", operation: "whatsapp.disclosureEvidence" },
});

const queueKeyHexLength = 32;

/** Bounded deterministic native queue key; source identifiers remain in the payload only. */
export const disclosureEvidenceQueueId = Effect.fn(function* (input: DisclosureRevision) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`${input.attemptId}/${input.evidenceRevision}`))
    .pipe(Effect.orDie);
  return Encoding.encodeHex(digest).slice(0, queueKeyHexLength);
});

/** Stable DurableDeferred identity for one effective evidence revision. */
export const disclosureEvidenceDeferredName = (input: DisclosureRevision): string =>
  `Evidence/${input.attemptId}/${input.evidenceRevision}`;

/** One observation's wake-up: every effective evidence change completes the prior revision once. */
export const disclosureEvidenceChanged = (
  input: DisclosureRevision
): DurableDeferred.DurableDeferred<typeof Schema.Void> =>
  DurableDeferred.make(disclosureEvidenceDeferredName(input));
