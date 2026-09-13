import { Duration, Schema } from "effect";

/** SQL table identity shared by every production durable queue. */
export const durableQueueTableName = "fidy_queue";

/** Store polling cadence: eligible rows are reclaimed promptly without busy-looping Postgres. */
export const durableQueuePollInterval: Duration.Input = "1 second";

/** Active-lease renewal cadence while scoped takes are running. */
export const durableQueueLockRefreshInterval: Duration.Input = "30 seconds";

/** Lease lifetime; must exceed the longest supported handler pause while refresh stays active. */
export const durableQueueLockExpiration: Duration.Input = "10 minutes";

/** Whole-second expiry, ceiled exactly as the store converts it for the lease comparison. */
export const durableQueueLockExpirationSeconds: number = Math.ceil(
  Duration.toSeconds(Duration.fromInputUnsafe(durableQueueLockExpiration))
);

/** Whole-second refresh cadence; production derives the stalled-lease threshold from it. */
export const durableQueueLockRefreshSeconds: number = Math.ceil(
  Duration.toSeconds(Duration.fromInputUnsafe(durableQueueLockRefreshInterval))
);

/** Active-lease age that indicates two consecutive missed refreshes. */
export const durableQueueLeaseStallSeconds: number = 2 * durableQueueLockRefreshSeconds;

/** Settlement and I/O overhead allowed on top of the modelled model-round budget. */
export const durableQueueHandlerSettlementOverheadSeconds = 30;

/** Longest supported handler pause, including settlement overhead. */
export const durableQueueLongestHandlerPauseSeconds = 210;

/** Every stable queue name sharing the production table. Queue identity is global, not User-scoped. */
export const durableQueueNames = [
  "whatsapp-consent-disclosure",
  "whatsapp-consent-disclosure-evidence",
  "onboarding-email-delivery",
  "whatsapp-inbound-turn",
  "browser-pairing-email-start",
  "browser-pairing-email-delivery",
  "browser-pairing-email-expiry",
  "subscription-billing-attempt",
  "email-replacement-delivery",
  "email-replacement-expiry",
  "forwarded-email-ingestion",
  "statement-ingestion",
] as const;

/** One stable queue identity from the shared production table. */
export type DurableQueueName = (typeof durableQueueNames)[number];

/** Native delivery ceiling used by queues without an owner-specific override. */
export const durableQueueDefaultMaxAttempts = 10;

/** Failure marker written when exhausted work has an incompatible payload schema. */
export const durableQueueSchemaIncompatibleMarker = "schema_incompatible";

/** Failure prefix written by the store for payload schema decode failures. */
export const durableQueueNativeDecodeFailurePrefix = "SchemaError:";

/** Prefix the SQL store records when persisted payload text is not valid JSON. */
export const durableQueueNativeJsonFailurePrefix = "SyntaxError:";

/** Pending depth that pages an operator: one full retention page of undrained eligible work. */
export const durableQueueBacklogDepth = 256;

/** Oldest eligible pending age in seconds that pages an operator: fifteen minutes without drain. */
export const durableQueueBacklogAgeSeconds = 900;

/** Bounded per-queue counts the health probe classifies; never payload or failure content. */
export type DurableQueueSignals = Readonly<{
  readonly pendingDepth: number;
  readonly oldestPendingAgeSeconds: number;
  readonly staleLeaseCount: number;
  readonly stalledLeaseCount: number;
  readonly exhaustedCount: number;
  readonly decodeFailureCount: number;
}>;

/** One queue's closed set of operational attention flags. */
export const DurableQueueAttention = Schema.Struct({
  backlog: Schema.Boolean,
  leaseChurn: Schema.Boolean,
  exhausted: Schema.Boolean,
  decodeFailure: Schema.Boolean,
});
export type DurableQueueAttention = typeof DurableQueueAttention.Type;

/**
 * Classifies one queue's bounded signals into alert flags. Stalled leases missed refreshes while
 * still live; stale leases are held past expiry (refresh failed and stayed failed, or a runtime
 * died without releasing); exhausted rows have spent their owner-declared delivery ceiling and
 * will never be reclaimed by polling.
 */
export const classifyDurableQueueAttention = (
  signals: DurableQueueSignals
): DurableQueueAttention => ({
  backlog:
    signals.pendingDepth >= durableQueueBacklogDepth ||
    signals.oldestPendingAgeSeconds >= durableQueueBacklogAgeSeconds,
  leaseChurn: signals.staleLeaseCount > 0 || signals.stalledLeaseCount > 0,
  exhausted: signals.exhaustedCount > 0,
  decodeFailure: signals.decodeFailureCount > 0,
});

/** Whether any alert flag is set for one queue. */
export const hasDurableQueueAttention = (attention: DurableQueueAttention): boolean =>
  attention.backlog || attention.leaseChurn || attention.exhausted || attention.decodeFailure;

/**
 * Whether one queue's attention is retryable. Polling can recover backlog, lease churn, and decode
 * failures that have not yet exhausted their delivery ceiling.
 */
export const isTransientDurableQueueAttention = (attention: DurableQueueAttention): boolean =>
  attention.backlog || attention.leaseChurn || (attention.decodeFailure && !attention.exhausted);

/** Whether one queue contains exhausted work that polling can no longer reclaim. */
export const isPermanentDurableQueueAttention = (attention: DurableQueueAttention): boolean =>
  attention.exhausted;
