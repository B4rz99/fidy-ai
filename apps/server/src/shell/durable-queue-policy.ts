import { Duration } from "effect";

/**
 * The deliberate production operating policy for the shared SQL PersistedQueue store. Production
 * provides these values to `PersistedQueue.layerStoreSql` instead of silently inheriting the
 * upstream defaults (1-second poll, 30-second refresh, 2-minute expiry, `effect_queue` table), so
 * the operating point is reviewed here rather than discovered from vendor source.
 *
 * Lease sizing is driven by the longest queue-lease holder, `whatsapp-inbound-turn`: one
 * `agent.handleWhatsAppWork` turn runs up to 6 model iterations at up to 30 seconds per round
 * (`CurrentAgentLimits`), about 180 seconds before settlement overhead. The 10-minute expiry holds
 * more than twice that pause with the 30-second refresh continuously renewing the lease (a 20:1
 * refresh-to-expiry ratio), so a healthy handler never loses its lease while a dead runtime's work
 * still becomes stealable within minutes.
 */
export const durableQueueTableName = "fidy_queue";

/** Store polling cadence: eligible rows are reclaimed promptly without busy-looping Postgres. */
export const durableQueuePollInterval: Duration.Input = "1 second";

/** Active-lease renewal cadence while scoped takes are running. */
export const durableQueueLockRefreshInterval: Duration.Input = "30 seconds";

/** Lease lifetime; must exceed the longest supported handler pause while refresh stays active. */
export const durableQueueLockExpiration: Duration.Input = "10 minutes";

/** Whole-second expiry as the store truncates it for the lease comparison. */
export const durableQueueLockExpirationSeconds: number = Math.ceil(
  Duration.toSeconds(Duration.fromInputUnsafe(durableQueueLockExpiration))
);

/** Whole-second refresh cadence, kept only to pin the refresh-to-expiry ratio in tests. */
export const durableQueueLockRefreshSeconds: number = Math.ceil(
  Duration.toSeconds(Duration.fromInputUnsafe(durableQueueLockRefreshInterval))
);

/**
 * Consecutive refresh intervals an active lease may miss before the probe reports it as stalled.
 * One missed refresh is tolerated as jitter; two in a row indicate the store's refresh loop is
 * failing while the lease is still live, which is visible minutes before expiry would make the
 * work stealable.
 */
export const durableQueueLeaseStallSeconds: number = 2 * durableQueueLockRefreshSeconds;

/** Settlement and I/O overhead allowed on top of the modelled model-round budget. */
export const durableQueueHandlerSettlementOverheadSeconds = 30;

/**
 * Longest supported uninterrupted handler pause in seconds: 6 model iterations at 30 seconds per
 * round plus settlement overhead. `durableQueueLockExpirationSeconds` must hold a documented
 * multiple of this bound; the policy test pins the bound to the configured `CurrentAgentLimits`
 * defaults, so raising handler limits fails the test until this budget is re-derived.
 */
export const durableQueueLongestHandlerPauseSeconds = 210;

/** Every stable queue name sharing the production table. Queue identity is global, not User-scoped. */
export const durableQueueNames = [
  "whatsapp-inbound-turn",
  "whatsapp-consent-disclosure",
  "whatsapp-consent-disclosure-evidence",
  "onboarding-email-delivery",
  "browser-pairing-email-start",
  "browser-pairing-email-delivery",
  "browser-pairing-email-expiry",
  "email-replacement-delivery",
  "email-replacement-expiry",
  "statement-ingestion",
  "subscription-billing-attempt",
  "forwarded-email-ingestion",
] as const;

/** One stable queue identity from the shared production table. */
export type DurableQueueName = (typeof durableQueueNames)[number];

/**
 * Per-queue delivery ceiling. Statement ingestion fails fast with typed terminal handling after 3
 * attempts; every other queue uses the native default ceiling of 10.
 */
export const durableQueueMaxAttempts: Record<DurableQueueName, number> = {
  "whatsapp-inbound-turn": 10,
  "whatsapp-consent-disclosure": 10,
  "whatsapp-consent-disclosure-evidence": 10,
  "onboarding-email-delivery": 10,
  "browser-pairing-email-start": 10,
  "browser-pairing-email-delivery": 10,
  "browser-pairing-email-expiry": 10,
  "email-replacement-delivery": 10,
  "email-replacement-expiry": 10,
  "statement-ingestion": 3,
  "subscription-billing-attempt": 10,
  "forwarded-email-ingestion": 10,
};

/**
 * Native `PersistedQueue` attempt ceiling. Test-only queue names fall back to this rather than
 * inventing a stricter budget.
 */
const durableQueueNativeMaxAttempts = 10;

/**
 * Delivery ceiling for one queue name. Unknown names (test-only queues) fall back to the native
 * default ceiling rather than inventing a stricter budget.
 */
export const maxAttemptsForDurableQueue = (queueName: string): number => {
  for (const name of durableQueueNames) {
    if (name === queueName) return durableQueueMaxAttempts[name];
  }
  return durableQueueNativeMaxAttempts;
};

/**
 * Durable decode-failure marker. Native schema decode failures store `Cause.pretty` in
 * `last_failure`; the WhatsApp exhausted-work retirement instead writes this exact marker so the
 * health probe can count confirmed decode failures with an equality match, never by reading
 * failure text.
 */
export const durableQueueSchemaIncompatibleMarker = "schema_incompatible";

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
  readonly schemaIncompatibleCount: number;
}>;

/**
 * One queue's alert flags. Transient backlog and lease churn remain retryable and recover on
 * redelivery; exhausted and decode-failure work is permanently ineligible and needs an operator
 * decision, never another retry.
 */
export type DurableQueueAttention = Readonly<{
  readonly backlog: boolean;
  readonly leaseChurn: boolean;
  readonly exhausted: boolean;
  readonly decodeFailure: boolean;
}>;

/**
 * Classifies one queue's bounded signals into alert flags. Stalled leases missed refreshes while
 * still live; stale leases are held past expiry (refresh failed and stayed failed, or a runtime
 * died without releasing); exhausted rows have spent `maxAttemptsForDurableQueue` and will never be
 * reclaimed by polling.
 */
export const classifyDurableQueueAttention = (
  signals: DurableQueueSignals
): DurableQueueAttention => ({
  backlog:
    signals.pendingDepth >= durableQueueBacklogDepth ||
    signals.oldestPendingAgeSeconds >= durableQueueBacklogAgeSeconds,
  leaseChurn: signals.staleLeaseCount > 0 || signals.stalledLeaseCount > 0,
  exhausted: signals.exhaustedCount > 0,
  decodeFailure: signals.schemaIncompatibleCount > 0,
});

/** Whether any alert flag is set for one queue. */
export const hasDurableQueueAttention = (attention: DurableQueueAttention): boolean =>
  attention.backlog || attention.leaseChurn || attention.exhausted || attention.decodeFailure;

/**
 * Whether one queue's attention is transient backlog or lease churn. Transient attention is
 * retryable: polling and redelivery recover it without operator action.
 */
export const isTransientDurableQueueAttention = (attention: DurableQueueAttention): boolean =>
  attention.backlog || attention.leaseChurn;

/**
 * Whether one queue's attention is permanently ineligible work (exhausted attempts or confirmed
 * decode failure). No retry reclaims it, so it needs an operator decision.
 */
export const isPermanentDurableQueueAttention = (attention: DurableQueueAttention): boolean =>
  attention.exhausted || attention.decodeFailure;
