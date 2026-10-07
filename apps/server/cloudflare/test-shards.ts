// Historical single-run Linux scheduling estimates from Checks run 37552158122.
// This run measures the final pooled fixtures and the new allowance suite; weights
// remain estimates rather than equivalent-revision median performance evidence.
// See docs/ci-performance.md and scripts/adapter-timings.ts. Every discovered file
// is assigned, including new files without a measurement.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "agent/hosted-turn.test.ts": 89.3,
  "transactions/transactions.test.ts": 74.1,
  "oauth-agents/oauth-confirmation.test.ts": 68.2,
  "oauth-agents/oauth-ingress.test.ts": 58.4,
  "dashboard/dashboard.test.ts": 56.4,
  "oauth-agents/oauth-canonical.test.ts": 49.9,
  "oauth-agents/oauth-refresh.test.ts": 49.0,
  "oauth-agents/oauth-discovery.test.ts": 43.7,
  "recurring/recurring.test.ts": 42.7,
  "budgets/budgets.test.ts": 32.2,
  "ingestion/statement-ingestion.test.ts": 31.9,
  "oauth-agents/oauth-allowance.test.ts": 23.7,
  "oauth-agents/oauth-management.test.ts": 23.1,
  "subscription/payment-enrollment.test.ts": 21.5,
  "oauth-agents/oauth-native-residency.test.ts": 21.2,
  "tokens/pats.test.ts": 20.4,
  "categories/keyword-rules.test.ts": 20.0,
  "canonical-admission/operations.test.ts": 17.8,
  "insights/proactivity-runtime.test.ts": 15.8,
  "memory/memory.test.ts": 15.3,
  "subscription/refunds.test.ts": 12.5,
  "ingestion/forwarded-email.test.ts": 12.2,
  "transactions/oauth-review.test.ts": 10.6,
  "weekly-workflow.test.ts": 8.4,
  "email-authentication/retention.test.ts": 8.3,
  "subscription/daviplata-migration.test.ts": 8.3,
  "insights/weekly-runtime.test.ts": 6.8,
  "onboarding/consent-ingress.test.ts": 6.1,
  "subscription/refund-support.test.ts": 6.1,
  "subscription/billing-collection.test.ts": 5.8,
  "ingestion/statement-processing.test.ts": 5.4,
  "insights/reminder-schedule.test.ts": 5.4,
  "onboarding/verified-onboarding.test.ts": 5.2,
  "ingestion/statement-staging.test.ts": 4.7,
  "insights/reminder-canonical.test.ts": 4.6,
  "audit/internal/audit.test.ts": 4.2,
  "insights/insight-store.test.ts": 3.7,
  "whatsapp/insight-delivery.test.ts": 3.3,
  "consent/proactivity-consent.test.ts": 3.2,
  "insights/governor.test.ts": 2.8,
  "transactions/peer-reads.test.ts": 2.8,
  "resource-admission/resource-admission.test.ts": 2.6,
  "agent/proactive-transcript.test.ts": 2.5,
  "consent/weekly-consent.test.ts": 2.2,
  "runtime/operational-health/alert-delivery.test.ts": 2.2,
  "subscription/subscription-queries.test.ts": 2.1,
  "ingestion/media-submissions.test.ts": 2.0,
  "insights/weekly-summary.test.ts": 2.0,
  "agent/proactivity-choice.test.ts": 1.6,
  "audit/internal/reminder-audit-migration.test.ts": 1.6,
  "ingestion/forwarding-address.test.ts": 1.5,
  "core-http/internal/session-clock.test.ts": 1.4,
  "ai/workers-ai.test.ts": 1.1,
  "recovery/support-recovery.test.ts": 1.1,
  "d1-test-fixture.test.ts": 1.0,
  "subscription/payment-enrollment-claim.test.ts": 1.0,
};

/** Assigns every discovered file once, longest estimated work first, to the lightest shard. */
export const cloudflareTestShards = ({
  files,
  cloudflareRoot,
  count,
}: Readonly<{
  files: ReadonlyArray<string>;
  cloudflareRoot: string;
  count: number;
}>): ReadonlyArray<ReadonlyArray<string>> => {
  if (!Number.isInteger(count) || count < 1) throw new Error("Shard count must be positive");
  const prefix = `${cloudflareRoot.replaceAll("\\", "/").replace(/\/$/u, "")}/`;
  const duration = (file: string): number =>
    estimatedSeconds[file.replaceAll("\\", "/").slice(prefix.length)] ?? 1;
  const shards = Array.from({ length: count }, () => {
    const shardFiles: string[] = [];
    return { files: shardFiles, seconds: 0 };
  });
  const ordered = [...files].sort((left, right) => {
    const difference = duration(right) - duration(left);
    if (difference !== 0) return difference;
    if (left < right) return -1;
    return left > right ? 1 : 0;
  });
  for (const file of ordered) {
    const lightest = shards.reduce((selected, shard) =>
      shard.seconds < selected.seconds ? shard : selected
    );
    lightest.files.push(file);
    lightest.seconds += duration(file);
  }
  return shards.map((shard) => shard.files);
};
