// Historical single-run Linux scheduling estimates from Checks run 37553520106.
// This run measures three-process native execution and split query cases; weights
// remain estimates rather than equivalent-revision median performance evidence.
// Recurring retains its conservative pre-bootstrap-fix measurement from that run.
// See docs/ci-performance.md and scripts/adapter-timings.ts. Every discovered file
// is assigned, including new files without a measurement.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "oauth-agents/oauth-confirmation.test.ts": 117.7,
  "agent/hosted-turn.test.ts": 114.5,
  "oauth-agents/oauth-ingress.test.ts": 99.9,
  "transactions/transactions.test.ts": 94.4,
  "dashboard/dashboard.test.ts": 94.3,
  "recurring/recurring.test.ts": 75.5,
  "oauth-agents/oauth-discovery.test.ts": 73.4,
  "oauth-agents/oauth-canonical.test.ts": 68.3,
  "oauth-agents/oauth-refresh.test.ts": 60.1,
  "ingestion/statement-ingestion.test.ts": 57.2,
  "budgets/budgets.test.ts": 47.7,
  "tokens/pats.test.ts": 46.4,
  "oauth-agents/oauth-native-residency.test.ts": 42.3,
  "oauth-agents/oauth-allowance.test.ts": 37.4,
  "subscription/payment-enrollment.test.ts": 36.1,
  "categories/keyword-rules.test.ts": 28.5,
  "memory/memory.test.ts": 27.2,
  "oauth-agents/oauth-management.test.ts": 26.4,
  "insights/proactivity-runtime.test.ts": 25.2,
  "subscription/refunds.test.ts": 24.9,
  "canonical-admission/operations.test.ts": 23.4,
  "transactions/oauth-review.test.ts": 18.3,
  "subscription/daviplata-migration.test.ts": 15.9,
  "ingestion/forwarded-email.test.ts": 14.0,
  "weekly-workflow.test.ts": 13.8,
  "insights/weekly-runtime.test.ts": 11.8,
  "onboarding/consent-ingress.test.ts": 11.4,
  "email-authentication/retention.test.ts": 11.2,
  "ingestion/statement-processing.test.ts": 9.7,
  "audit/internal/audit.test.ts": 9.4,
  "subscription/refund-support.test.ts": 9.3,
  "subscription/billing-collection.test.ts": 8.9,
  "onboarding/verified-onboarding.test.ts": 8.4,
  "consent/proactivity-consent.test.ts": 7.9,
  "insights/insight-store.test.ts": 7.7,
  "insights/reminder-schedule.test.ts": 7.0,
  "whatsapp/insight-delivery.test.ts": 6.7,
  "ingestion/statement-staging.test.ts": 6.6,
  "insights/reminder-canonical.test.ts": 6.0,
  "agent/proactive-transcript.test.ts": 4.8,
  "consent/weekly-consent.test.ts": 4.5,
  "insights/weekly-summary.test.ts": 4.4,
  "insights/governor.test.ts": 4.3,
  "subscription/subscription-queries.test.ts": 3.8,
  "agent/proactivity-choice.test.ts": 3.6,
  "resource-admission/resource-admission.test.ts": 3.5,
  "audit/internal/reminder-audit-migration.test.ts": 3.4,
  "runtime/operational-health/alert-delivery.test.ts": 3.1,
  "transactions/peer-reads.test.ts": 3.1,
  "core-http/internal/session-clock.test.ts": 2.8,
  "ingestion/media-submissions.test.ts": 2.8,
  "ingestion/forwarding-address.test.ts": 1.9,
  "subscription/payment-enrollment-claim.test.ts": 1.9,
  "recovery/support-recovery.test.ts": 1.7,
  "d1-test-fixture.test.ts": 1.4,
  "ai/workers-ai.test.ts": 1.3,
  "ingestion/statement-document.test.ts": 1.3,
  "runtime/runtime.test.ts": 1.0,
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
