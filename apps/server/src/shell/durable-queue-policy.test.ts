import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { CurrentAgentLimits } from "~/shell/agent/agent-service";
import {
  maximumWhatsAppInboundAttempts,
  whatsappInboundConsumerCount,
} from "~/shell/channels/whatsapp/inbound-execution";
import { maximumStatementIngestionAttempts } from "~/shell/ingestion/worker";
import { maximumBillingAttemptQueueAttempts } from "~/shell/subscription/billing-repo";
import {
  type DurableQueueSignals,
  classifyDurableQueueAttention,
  durableQueueBacklogAgeSeconds,
  durableQueueBacklogDepth,
  durableQueueDefaultMaxAttempts,
  durableQueueHandlerSettlementOverheadSeconds,
  durableQueueLeaseStallSeconds,
  durableQueueLockExpirationSeconds,
  durableQueueLockRefreshSeconds,
  durableQueueLongestHandlerPauseSeconds,
  durableQueueNames,
  durableQueueNativeDecodeFailurePrefix,
  durableQueueNativeJsonFailurePrefix,
  hasDurableQueueAttention,
  isPermanentDurableQueueAttention,
  isTransientDurableQueueAttention,
} from "./durable-queue-policy";

const healthySignals: DurableQueueSignals = {
  pendingDepth: 0,
  oldestPendingAgeSeconds: 0,
  staleLeaseCount: 0,
  stalledLeaseCount: 0,
  exhaustedCount: 0,
  decodeFailureCount: 0,
};

it("declares one stable queue name per production queue within the Effect column bound", () => {
  expect(durableQueueNames.length).toBe(12);
  expect(new Set(durableQueueNames).size).toBe(durableQueueNames.length);
  for (const name of durableQueueNames) {
    expect(name).toMatch(/^[a-z0-9-]+$/u);
    expect(name.length).toBeLessThanOrEqual(100);
  }
});

it("keeps owner-specific retry budgets explicit beside the native ceiling", () => {
  expect(durableQueueDefaultMaxAttempts).toBe(10);
  expect(maximumStatementIngestionAttempts).toBe(3);
  expect(maximumWhatsAppInboundAttempts).toBe(10);
  expect(maximumBillingAttemptQueueAttempts).toBe(10);
});

it("pins native decode-failure prefixes to the store's failure rendering", () => {
  const schemaExit = Effect.runSync(
    Effect.exit(Schema.decodeUnknownEffect(Schema.Struct({ note: Schema.String }))({ note: null }))
  );
  expect(Exit.isFailure(schemaExit)).toBe(true);
  if (Exit.isFailure(schemaExit)) {
    expect(Cause.pretty(schemaExit.cause).startsWith(durableQueueNativeDecodeFailurePrefix)).toBe(
      true
    );
  }
  const jsonExit = Effect.runSync(
    Effect.exit(
      Effect.sync(() => {
        throw new SyntaxError("invalid persisted JSON");
      })
    )
  );
  expect(Exit.isFailure(jsonExit)).toBe(true);
  if (Exit.isFailure(jsonExit)) {
    expect(Cause.pretty(jsonExit.cause).startsWith(durableQueueNativeJsonFailurePrefix)).toBe(true);
  }
});

it("declares eight longest-handler lanes per runtime", () => {
  expect(whatsappInboundConsumerCount).toBe(8);
});

it("holds lock expiry above twice the longest handler pause with active refresh", () => {
  expect(durableQueueLockExpirationSeconds).toBe(600);
  expect(durableQueueLockRefreshSeconds).toBe(30);
  expect(durableQueueLockExpirationSeconds).toBeGreaterThanOrEqual(
    2 * durableQueueLongestHandlerPauseSeconds
  );
  expect(durableQueueLockExpirationSeconds / durableQueueLockRefreshSeconds).toBe(20);
});

it("sizes the handler pause budget above the configured agent turn bounds", () => {
  const limits = CurrentAgentLimits.defaultValue();
  const modelledRoundSeconds = (limits.maxIterations * limits.maxModelRoundMillis) / 1_000;
  expect(durableQueueLongestHandlerPauseSeconds).toBeGreaterThanOrEqual(
    modelledRoundSeconds + durableQueueHandlerSettlementOverheadSeconds
  );
});

it("reports stalled active leases after two missed refreshes and before expiry", () => {
  expect(durableQueueLeaseStallSeconds).toBe(60);
  expect(durableQueueLeaseStallSeconds).toBeGreaterThan(durableQueueLockRefreshSeconds);
  expect(durableQueueLeaseStallSeconds).toBeLessThan(durableQueueLockExpirationSeconds);
});

it("leaves healthy queues without attention", () => {
  const attention = classifyDurableQueueAttention(healthySignals);
  expect(attention).toEqual({
    backlog: false,
    leaseChurn: false,
    exhausted: false,
    decodeFailure: false,
  });
  expect(hasDurableQueueAttention(attention)).toBe(false);
});

it("flags transient backlog by depth or age", () => {
  const byDepth = classifyDurableQueueAttention({
    ...healthySignals,
    pendingDepth: durableQueueBacklogDepth,
  });
  expect(byDepth.backlog).toBe(true);
  expect(hasDurableQueueAttention(byDepth)).toBe(true);
  const byAge = classifyDurableQueueAttention({
    ...healthySignals,
    oldestPendingAgeSeconds: durableQueueBacklogAgeSeconds,
  });
  expect(byAge.backlog).toBe(true);
  const below = classifyDurableQueueAttention({
    ...healthySignals,
    pendingDepth: durableQueueBacklogDepth - 1,
    oldestPendingAgeSeconds: durableQueueBacklogAgeSeconds - 1,
  });
  expect(below.backlog).toBe(false);
});

it("flags stale or stalled leases as churn independently of backlog", () => {
  const stale = classifyDurableQueueAttention({ ...healthySignals, staleLeaseCount: 1 });
  expect(stale).toEqual({
    backlog: false,
    leaseChurn: true,
    exhausted: false,
    decodeFailure: false,
  });
  const stalled = classifyDurableQueueAttention({ ...healthySignals, stalledLeaseCount: 1 });
  expect(stalled).toEqual({
    backlog: false,
    leaseChurn: true,
    exhausted: false,
    decodeFailure: false,
  });
});

it("flags permanently ineligible work separately from transient signals", () => {
  const exhausted = classifyDurableQueueAttention({ ...healthySignals, exhaustedCount: 2 });
  expect(exhausted.exhausted).toBe(true);
  expect(exhausted.backlog).toBe(false);
  expect(exhausted.leaseChurn).toBe(false);
  const decodeFailure = classifyDurableQueueAttention({
    ...healthySignals,
    decodeFailureCount: 1,
  });
  expect(decodeFailure.decodeFailure).toBe(true);
  expect(decodeFailure.exhausted).toBe(false);
  expect(isTransientDurableQueueAttention(decodeFailure)).toBe(true);
  expect(isPermanentDurableQueueAttention(decodeFailure)).toBe(false);
  const exhaustedDecodeFailure = classifyDurableQueueAttention({
    ...healthySignals,
    decodeFailureCount: 1,
    exhaustedCount: 1,
  });
  expect(isTransientDurableQueueAttention(exhaustedDecodeFailure)).toBe(false);
  expect(isPermanentDurableQueueAttention(exhaustedDecodeFailure)).toBe(true);
});
