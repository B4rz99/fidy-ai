// Historical single-run Linux scheduling estimates from Checks run 37545947947.
// This run measures the split suites and Worker-local schema preparation; weights
// remain estimates rather than equivalent-revision median performance evidence.
// See docs/ci-performance.md and scripts/adapter-timings.ts. Every discovered file
// is assigned, including new files without a measurement.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "agent/hosted-turn.test.ts": 77.3,
  "oauth-agents/oauth-confirmation.test.ts": 73.9,
  "oauth-agents/oauth-ingress.test.ts": 69.6,
  "transactions/transactions.test.ts": 65.2,
  "recurring/recurring.test.ts": 52.9,
  "oauth-agents/oauth-canonical.test.ts": 44.5,
  "oauth-agents/oauth-discovery.test.ts": 43.9,
  "oauth-agents/oauth-refresh.test.ts": 42.3,
  "dashboard/dashboard.test.ts": 41.8,
  "budgets/budgets.test.ts": 36.0,
  "oauth-agents/oauth-native-residency.test.ts": 24.8,
  "ingestion/statement-ingestion.test.ts": 24.1,
  "oauth-agents/oauth-management.test.ts": 19.0,
  "insights/proactivity-runtime.test.ts": 18.5,
  "memory/memory.test.ts": 18.1,
  "tokens/pats.test.ts": 17.8,
  "subscription/payment-enrollment.test.ts": 17.1,
  "ingestion/forwarded-email.test.ts": 16.9,
  "subscription/refunds.test.ts": 16.1,
  "canonical-admission/operations.test.ts": 14.7,
  "weekly-workflow.test.ts": 14.5,
  "onboarding/consent-ingress.test.ts": 13.4,
  "ingestion/statement-staging.test.ts": 13.3,
  "onboarding/verified-onboarding.test.ts": 12.8,
  "categories/keyword-rules.test.ts": 12.8,
  "transactions/oauth-review.test.ts": 12.4,
  "subscription/daviplata-migration.test.ts": 11.1,
  "insights/insight-store.test.ts": 8.4,
  "email-authentication/retention.test.ts": 7.3,
  "audit/internal/audit.test.ts": 6.1,
  "insights/weekly-runtime.test.ts": 5.3,
  "subscription/billing-collection.test.ts": 5.1,
  "d1-test-fixture.test.ts": 4.9,
  "insights/reminder-schedule.test.ts": 4.7,
  "ingestion/statement-processing.test.ts": 4.6,
  "whatsapp/insight-delivery.test.ts": 4.5,
  "subscription/refund-support.test.ts": 4.3,
  "consent/proactivity-consent.test.ts": 3.5,
  "agent/proactive-transcript.test.ts": 3.2,
  "insights/weekly-summary.test.ts": 3.0,
  "consent/weekly-consent.test.ts": 2.9,
  "insights/reminder-canonical.test.ts": 2.5,
  "subscription/subscription-queries.test.ts": 2.5,
  "transactions/peer-reads.test.ts": 2.3,
  "resource-admission/resource-admission.test.ts": 2.2,
  "runtime/operational-health/alert-delivery.test.ts": 2.2,
  "core-http/internal/session-clock.test.ts": 1.9,
  "ingestion/media-submissions.test.ts": 1.9,
  "agent/proactivity-choice.test.ts": 1.9,
  "insights/governor.test.ts": 1.9,
  "subscription/payment-enrollment-claim.test.ts": 1.3,
  "ingestion/forwarding-address.test.ts": 1.2,
  "audit/internal/reminder-audit-migration.test.ts": 1.1,
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
