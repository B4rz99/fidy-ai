import { Data, Schema } from "effect";
import type { RecoveryAdmissionEnvironment } from "../recovery-activation/contract";
import type { AuthoritativeStoreEnvironment } from "../sqlite-store/contract";

export type RecoveryLifecycleEnvironment = RecoveryAdmissionEnvironment &
  Pick<AuthoritativeStoreEnvironment, "SQLITE_STORE_EPOCH">;

export class RecoveryOperationUnavailable extends Data.TaggedError(
  "RecoveryOperationUnavailable"
) {}

export type RecoveryOperationLease = Readonly<{
  assertOpen: () => Promise<void>;
  complete: () => Promise<void>;
}>;

const maximumEpochLength = 128;
export const RecoveryWorkMetadata = Schema.Struct({
  recoveryEpoch: Schema.String.check(Schema.isBetweenLength(1, maximumEpochLength)),
});

export type RecoveryDispatchEnvironment = RecoveryLifecycleEnvironment &
  Partial<
    Readonly<{
      BROWSER_PAIRING_EMAIL_QUEUE: Queue;
      EMAIL_REPLACEMENT_QUEUE: Queue;
      BILLING_COLLECTION_QUEUE: Queue;
      HOSTED_WHATSAPP_QUEUE: Queue;
      STATEMENT_EXTRACTION_QUEUE: Queue;
      WEEKLY_DELIVERY_QUEUE: Queue;
      OPERATIONAL_CANARY_QUEUE: Queue;
      SMOKE_QUEUE: Queue;
      BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow;
      EMAIL_REPLACEMENT_WORKFLOW: Workflow;
      BILLING_COLLECTION_WORKFLOW: Workflow;
      BILLING_REFUND_WORKFLOW: Workflow;
      STATEMENT_EXTRACTION_WORKFLOW: Workflow;
      WEEKLY_DELIVERY_WORKFLOW: Workflow;
      OPERATIONAL_CANARY_WORKFLOW: Workflow;
      SMOKE_WORKFLOW: Workflow;
    }>
  >;

export type RecoveryNativeTracker = Readonly<{
  run: <A>(work: () => Promise<A>) => Promise<A>;
  settle: () => Promise<void>;
}>;

const DrainCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OwnerDrain = Schema.Struct({
  pending: DrainCount,
  ambiguous: DrainCount,
  preservedBlocked: DrainCount,
});

/** Closed coverage is source-owned; provider Queue/Workflow inventory is an independent barrier. */
export const RecoveryDrainObservation = Schema.Struct({
  version: Schema.Literal(1),
  coverage: Schema.Literal("source-owner-intents-v1"),
  pending: DrainCount,
  ambiguous: DrainCount,
  owners: Schema.Struct({
    subscription: OwnerDrain,
    emailAuthentication: OwnerDrain,
    hosted: OwnerDrain,
    whatsapp: OwnerDrain,
    insights: OwnerDrain,
    ingestion: OwnerDrain,
    connections: OwnerDrain,
    consentIngress: OwnerDrain,
    privateObjects: OwnerDrain,
  }),
});

/** Missing tables, unknown owner states, or unavailable evidence cannot authorize final close. */
export class RecoveryDrainUnavailable extends Data.TaggedError("RecoveryDrainUnavailable") {}
