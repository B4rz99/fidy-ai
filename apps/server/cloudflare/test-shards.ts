// Historical single-run Linux scheduling estimates from Checks run 37548664002.
// This run measures the split suites and two-process native execution; weights
// remain estimates rather than equivalent-revision median performance evidence.
// See docs/ci-performance.md and scripts/adapter-timings.ts. Every discovered file
// is assigned, including new files without a measurement.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "oauth-agents/oauth-ingress.test.ts": 87.2,
  "oauth-agents/oauth-confirmation.test.ts": 81.5,
  "dashboard/dashboard.test.ts": 76.2,
  "transactions/transactions.test.ts": 69.8,
  "agent/hosted-turn.test.ts": 67.5,
  "oauth-agents/oauth-canonical.test.ts": 65.0,
  "recurring/recurring.test.ts": 62.3,
  "oauth-agents/oauth-discovery.test.ts": 46.1,
  "ingestion/statement-ingestion.test.ts": 42.9,
  "oauth-agents/oauth-refresh.test.ts": 40.4,
  "budgets/budgets.test.ts": 35.6,
  "tokens/pats.test.ts": 33.6,
  "subscription/payment-enrollment.test.ts": 31.1,
  "categories/keyword-rules.test.ts": 31.0,
  "oauth-agents/oauth-native-residency.test.ts": 30.4,
  "oauth-agents/oauth-management.test.ts": 23.1,
  "ingestion/forwarded-email.test.ts": 21.2,
  "memory/memory.test.ts": 18.1,
  "insights/proactivity-runtime.test.ts": 16.7,
  "subscription/refunds.test.ts": 16.3,
  "canonical-admission/operations.test.ts": 16.2,
  "insights/insight-store.test.ts": 14.2,
  "transactions/oauth-review.test.ts": 13.8,
  "onboarding/consent-ingress.test.ts": 13.5,
  "ingestion/statement-staging.test.ts": 13.2,
  "weekly-workflow.test.ts": 12.7,
  "subscription/daviplata-migration.test.ts": 12.5,
  "onboarding/verified-onboarding.test.ts": 11.9,
  "insights/weekly-runtime.test.ts": 9.2,
  "ingestion/statement-processing.test.ts": 7.6,
  "subscription/refund-support.test.ts": 7.1,
  "email-authentication/retention.test.ts": 7.0,
  "subscription/billing-collection.test.ts": 6.2,
  "insights/reminder-canonical.test.ts": 5.8,
  "audit/internal/audit.test.ts": 5.4,
  "whatsapp/insight-delivery.test.ts": 5.3,
  "consent/proactivity-consent.test.ts": 4.3,
  "insights/reminder-schedule.test.ts": 4.2,
  "insights/governor.test.ts": 3.6,
  "agent/proactive-transcript.test.ts": 3.3,
  "d1-test-fixture.test.ts": 3.1,
  "resource-admission/resource-admission.test.ts": 3.1,
  "insights/weekly-summary.test.ts": 3.1,
  "consent/weekly-consent.test.ts": 2.9,
  "runtime/operational-health/alert-delivery.test.ts": 2.6,
  "agent/proactivity-choice.test.ts": 2.4,
  "subscription/subscription-queries.test.ts": 2.4,
  "transactions/peer-reads.test.ts": 2.0,
  "ai/workers-ai.test.ts": 2.0,
  "ingestion/media-submissions.test.ts": 1.8,
  "core-http/internal/session-clock.test.ts": 1.8,
  "audit/internal/reminder-audit-migration.test.ts": 1.7,
  "categories/operations.test.ts": 1.6,
  "access-tier.test.ts": 1.2,
  "subscription/payment-enrollment-claim.test.ts": 1.2,
  "ingestion/forwarding-address.test.ts": 1.2,
  "recovery/support-recovery.test.ts": 1.1,
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
