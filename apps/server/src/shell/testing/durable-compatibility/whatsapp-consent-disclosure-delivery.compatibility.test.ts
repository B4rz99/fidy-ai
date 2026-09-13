import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  DisclosureDeliveryAttemptId,
  DisclosureDeliveryAttemptNumber,
} from "~/shell/channels/whatsapp/disclosure-model";
import {
  disclosureActivityIdentities,
  disclosureEvidenceWakeName,
  disclosureExpiryClockName,
  disclosureRetryClockName,
  disclosureRetryWakeName,
  disclosureWakeDeferredCompletion,
} from "~/shell/channels/whatsapp/disclosure-delivery";
import {
  ConsentDisclosureEvidencePayload,
  ConsentDisclosurePayload,
  ConsentDisclosureSuccess,
  ConsentDisclosureWorkflow,
  consentDisclosureEvidenceQueueName,
  consentDisclosureQueueId,
  consentDisclosureQueueName,
  disclosureEvidenceDeferredName,
  disclosureEvidenceQueueId,
} from "~/shell/channels/whatsapp/disclosure-workflow";
import {
  type DurableWorkflowSpec,
  assertDurableWorkflowFixture,
  durableClockSpec,
  durableDeferredSpec,
  durableQueueSpec,
  durableRaceAllDeferredSpec,
  loadDurableWorkflowFixture,
} from "~/shell/testing/durable-compatibility";

const attemptId = DisclosureDeliveryAttemptId.make("019cda32-1250-7000-8000-000000000465");
const attemptNumber = DisclosureDeliveryAttemptNumber.make(1);
const secondAttemptNumber = DisclosureDeliveryAttemptNumber.make(2);

const spec: DurableWorkflowSpec = {
  workflow: ConsentDisclosureWorkflow,
  payloadSchema: ConsentDisclosurePayload,
  successSchema: ConsentDisclosureSuccess,
  errorSchema: Schema.Never,
  activities: {
    "send-1-0": disclosureActivityIdentities.send({ attemptNumber, evidenceRevision: 0 }),
    "send-2-3": disclosureActivityIdentities.send({
      attemptNumber: secondAttemptNumber,
      evidenceRevision: 3,
    }),
    "retry-1-0": disclosureActivityIdentities.retry({ attemptNumber, evidenceRevision: 0 }),
  },
  clocks: {
    "retry-1-0": durableClockSpec(disclosureRetryClockName({ attemptId, evidenceRevision: 0 })),
    expiry: durableClockSpec(disclosureExpiryClockName),
  },
  deferreds: {
    evidence: durableDeferredSpec(
      disclosureEvidenceDeferredName({ attemptId, evidenceRevision: 0 })
    ),
    "retry-wake": durableRaceAllDeferredSpec({
      name: disclosureRetryWakeName({ attemptId, evidenceRevision: 0 }),
      completion: disclosureWakeDeferredCompletion,
    }),
    "evidence-wake": durableRaceAllDeferredSpec({
      name: disclosureEvidenceWakeName({ attemptId, evidenceRevision: 0 }),
      completion: disclosureWakeDeferredCompletion,
    }),
  },
  queues: [
    durableQueueSpec({
      key: "delivery",
      name: consentDisclosureQueueName,
      schema: ConsentDisclosurePayload,
      queueId: (payload) => Effect.succeed(consentDisclosureQueueId(payload)),
    }),
    durableQueueSpec({
      key: "evidence",
      name: consentDisclosureEvidenceQueueName,
      schema: ConsentDisclosureEvidencePayload,
      queueId: (payload) => Effect.succeed(disclosureEvidenceQueueId(payload)),
    }),
  ],
};

describe("WhatsAppConsentDisclosureDelivery durable compatibility", () => {
  it.effect("decodes every checked-in persisted boundary and re-encodes it", () =>
    assertDurableWorkflowFixture(
      loadDurableWorkflowFixture("whatsapp-consent-disclosure-delivery"),
      spec
    )
  );
});
