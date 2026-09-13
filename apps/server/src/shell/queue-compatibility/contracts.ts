import type { Schema } from "effect";
import type { PersistedQueue } from "effect/unstable/persistence";
import {
  ConsentDisclosureEvidencePayload,
  ConsentDisclosurePayload,
  consentDisclosureEvidenceQueue,
  consentDisclosureEvidenceQueueName,
  consentDisclosureQueue,
  consentDisclosureQueueName,
} from "~/shell/channels/whatsapp/disclosure-workflow";
import {
  WhatsAppInboundWork,
  whatsappInboundQueue,
  whatsappInboundQueueName,
} from "~/shell/channels/whatsapp/inbound-execution";
import {
  PairingDeliveryPayload,
  PairingExpiryPayload,
  PairingStartPayload,
  pairingDeliveryQueue,
  pairingDeliveryQueueName,
  pairingExpiryQueue,
  pairingExpiryQueueName,
  pairingStartQueue,
  pairingStartQueueName,
} from "~/shell/email-authentication/pairing-email-execution";
import {
  ReplacementDeliveryPayload,
  ReplacementExpiryPayload,
  replacementDeliveryQueue,
  replacementDeliveryQueueName,
  replacementExpiryQueue,
  replacementExpiryQueueName,
} from "~/shell/email-authentication/replacement-protocol";
import {
  ForwardedEmailWorkflowPayload,
  forwardedEmailQueueName,
  forwardedEmailWorkflowQueue,
} from "~/shell/ingestion/forwarded-email-execution";
import {
  StatementIngestionPayload,
  statementIngestionQueue,
  statementIngestionQueueName,
} from "~/shell/ingestion/worker";
import {
  OnboardingDeliveryPayload,
  onboardingDeliveryQueueName,
  onboardingEmailDeliveryQueue,
} from "~/shell/onboarding/delivery-workflow";
import {
  BillingAttemptReconciliationPayload,
  billingAttemptQueue,
} from "~/shell/subscription/billing-attempt-execution";
import { billingAttemptQueueName } from "~/shell/subscription/billing-repo";

/**
 * SQL column bounds enforced by Effect's PersistedQueue migration. Queue names
 * live in `VARCHAR(100)` and custom ids in `VARCHAR(36)`; a longer value fails
 * at offer time and strands the producing transaction, so every production
 * queue and every custom-id derivation stays within these bounds.
 */
export const maximumQueueNameLength = 100;
export const maximumQueueIdLength = 36;

/**
 * Every production PersistedQueue name. A rolling deployment decodes work
 * offered by the previous deployment, so renaming a queue strands in-flight
 * rows on the old name. Additive payload changes use backward-readable
 * defaults or unions; an incompatible change requires a named new queue or an
 * explicit drain/migration plan recorded alongside the new fixture.
 */
export const productionQueueNames = [
  consentDisclosureQueueName,
  consentDisclosureEvidenceQueueName,
  onboardingDeliveryQueueName,
  whatsappInboundQueueName,
  pairingStartQueueName,
  pairingDeliveryQueueName,
  pairingExpiryQueueName,
  billingAttemptQueueName,
  replacementDeliveryQueueName,
  replacementExpiryQueueName,
  forwardedEmailQueueName,
  statementIngestionQueueName,
] as const;
export type ProductionQueueName = (typeof productionQueueNames)[number];

/**
 * One production queue's compatibility contract. The schema is the decoder the
 * owning slice builds its queue with; the fixture (`<name>.json`) is the oldest
 * supported encoding; the identity fields are the domain ownership and
 * operation identity that must survive a rolling deployment without changing
 * deduplication or stranding work.
 */
export type QueueCompatibilityContract<SchemaType extends Schema.Constraint = Schema.Constraint> = {
  readonly name: ProductionQueueName;
  readonly schema: SchemaType;
  readonly identityFields: ReadonlyArray<string>;
  readonly userFields: ReadonlyArray<string>;
};

/** The production queue Effect for one payload schema, used as a compile-time witness. */
type ProductionQueue<SchemaValue extends Schema.Constraint> = ReturnType<
  typeof PersistedQueue.make<SchemaValue>
>;

const defineContract = <SchemaValue extends Schema.Constraint>(contract: {
  readonly name: ProductionQueueName;
  readonly schema: SchemaValue;
  /** Witness that the production queue is still built from this exact schema. */
  readonly queue: ProductionQueue<SchemaValue>;
  readonly identityFields: ReadonlyArray<string>;
  readonly userFields: ReadonlyArray<string>;
}): QueueCompatibilityContract<SchemaValue> => contract;

/**
 * Executable registry for every production queue. Tests decode each fixture with
 * the current schema and assert the same explicit User/domain ownership and
 * operation identity, so an old producer's row completes once under a new
 * consumer and duplicate custom ids still converge on one logical item. The
 * unit suite also scans production `PersistedQueue.make` call sites and requires
 * every name/schema pair to appear here, so adding or rewiring a queue fails
 * until its contract is reviewed.
 */
export const productionQueueContracts = [
  defineContract({
    name: consentDisclosureQueueName,
    schema: ConsentDisclosurePayload,
    queue: consentDisclosureQueue,
    identityFields: ["exchangeId"],
    userFields: [],
  }),
  defineContract({
    name: consentDisclosureEvidenceQueueName,
    schema: ConsentDisclosureEvidencePayload,
    queue: consentDisclosureEvidenceQueue,
    identityFields: ["exchangeId", "attemptId", "evidenceRevision"],
    userFields: [],
  }),
  defineContract({
    name: onboardingDeliveryQueueName,
    schema: OnboardingDeliveryPayload,
    queue: onboardingEmailDeliveryQueue,
    identityFields: ["intentId"],
    userFields: [],
  }),
  defineContract({
    name: whatsappInboundQueueName,
    schema: WhatsAppInboundWork,
    queue: whatsappInboundQueue,
    identityFields: ["inboundJobId"],
    userFields: ["userId"],
  }),
  defineContract({
    name: pairingStartQueueName,
    schema: PairingStartPayload,
    queue: pairingStartQueue,
    identityFields: ["requestId"],
    userFields: [],
  }),
  defineContract({
    name: pairingDeliveryQueueName,
    schema: PairingDeliveryPayload,
    queue: pairingDeliveryQueue,
    identityFields: ["intentId"],
    userFields: ["userId"],
  }),
  defineContract({
    name: pairingExpiryQueueName,
    schema: PairingExpiryPayload,
    queue: pairingExpiryQueue,
    identityFields: ["workflowId"],
    userFields: ["userId"],
  }),
  defineContract({
    name: billingAttemptQueueName,
    schema: BillingAttemptReconciliationPayload,
    queue: billingAttemptQueue,
    identityFields: ["billingAttemptId"],
    userFields: ["userId"],
  }),
  defineContract({
    name: replacementDeliveryQueueName,
    schema: ReplacementDeliveryPayload,
    queue: replacementDeliveryQueue,
    identityFields: ["intentId"],
    userFields: ["userId"],
  }),
  defineContract({
    name: replacementExpiryQueueName,
    schema: ReplacementExpiryPayload,
    queue: replacementExpiryQueue,
    identityFields: ["workflowId"],
    userFields: ["userId"],
  }),
  defineContract({
    name: forwardedEmailQueueName,
    schema: ForwardedEmailWorkflowPayload,
    queue: forwardedEmailWorkflowQueue,
    identityFields: ["receivedEmailId"],
    userFields: ["userId"],
  }),
  defineContract({
    name: statementIngestionQueueName,
    schema: StatementIngestionPayload,
    queue: statementIngestionQueue,
    identityFields: ["submissionId"],
    userFields: ["userId"],
  }),
];
