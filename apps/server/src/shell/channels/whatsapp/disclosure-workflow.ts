import { createHash } from "node:crypto";
import { Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { DurableDeferred, Workflow } from "effect/unstable/workflow";
import { PendingConsentExchangeId } from "~/core/consent/model";
import { DisclosureDeliveryAttemptId, DisclosureDeliveryFailureReason } from "./disclosure-model";

/** Identifier-only pre-User work. No User exists before verified onboarding completes. */
export const ConsentDisclosurePayload = Schema.Struct({
  revision: Schema.Literal(1),
  exchangeId: PendingConsentExchangeId,
});

/** Delivery is established by authenticated delivered/read evidence, never provider send acceptance. */
export const ConsentDisclosureSuccess = Schema.Struct({
  outcome: Schema.Literals(["delivered", "not-current"]),
});

/** Closed provider failure retained by execution history without provider bodies or routing data. */
export class ConsentDisclosureFailed extends Schema.Error<ConsentDisclosureFailed>(
  "ConsentDisclosureFailed"
)({
  _tag: Schema.tag("ConsentDisclosureFailed"),
  outcome: Schema.Literals(["rejected", "retry-exhausted"]),
  reason: DisclosureDeliveryFailureReason,
}) {}

/** One durable execution per eligible pending Consent exchange, independently of inbound redelivery. */
export const ConsentDisclosureWorkflow = Workflow.make("WhatsAppConsentDisclosureDelivery", {
  payload: ConsentDisclosurePayload,
  success: ConsentDisclosureSuccess,
  error: ConsentDisclosureFailed,
  idempotencyKey: ({ exchangeId }) => exchangeId,
});

/** Transactional acceptance handoff using the shared SQL client; completion is not delivery evidence. */
export const consentDisclosureQueue = PersistedQueue.make({
  name: "whatsapp-consent-disclosure",
  schema: ConsentDisclosurePayload,
});

/** Identifier-only evidence handoff, committed with Consent facts and completed outside SQL locks. */
export const consentDisclosureEvidenceQueue = PersistedQueue.make({
  name: "whatsapp-consent-disclosure-evidence",
  schema: Schema.Struct({
    revision: Schema.Literal(1),
    exchangeId: PendingConsentExchangeId,
    attemptId: DisclosureDeliveryAttemptId,
    evidenceRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
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
