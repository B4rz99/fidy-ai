// Historical single-run Linux scheduling estimates from Checks run 37542170991.
// These are relative weights, not equivalent-revision performance measurements;
// see docs/ci-performance.md and scripts/adapter-timings.ts for validation evidence.
// Split OAuth weights sum the original per-case durations; new file startup costs
// and fixture optimizations need fresh CI measurement. Every discovered file is
// assigned, including new files without a measurement.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "transactions/transactions.test.ts": 112.5,
  "dashboard/dashboard.test.ts": 101.2,
  "oauth-agents/oauth-ingress.test.ts": 93.9,
  "oauth-agents/oauth-confirmation.test.ts": 92.2,
  "agent/hosted-turn.test.ts": 88,
  "oauth-agents/oauth-canonical.test.ts": 67.8,
  "ingestion/statement-ingestion.test.ts": 65.9,
  "oauth-agents/oauth-refresh.test.ts": 60.3,
  "oauth-agents/oauth-discovery.test.ts": 55.2,
  "tokens/pats.test.ts": 50.9,
  "budgets/budgets.test.ts": 49.3,
  "recurring/recurring.test.ts": 42.7,
  "oauth-agents/oauth-native-residency.test.ts": 33.5,
  "subscription/payment-enrollment.test.ts": 29.1,
  "insights/proactivity-runtime.test.ts": 28,
  "oauth-agents/oauth-management.test.ts": 27.2,
  "categories/keyword-rules.test.ts": 21.6,
  "canonical-admission/operations.test.ts": 17,
  "memory/memory.test.ts": 16.8,
  "weekly-workflow.test.ts": 16.8,
  "ingestion/forwarded-email.test.ts": 16.1,
  "subscription/refunds.test.ts": 15.8,
  "transactions/oauth-review.test.ts": 15.8,
  "insights/insight-store.test.ts": 15,
  "onboarding/consent-ingress.test.ts": 12.8,
  "ingestion/statement-staging.test.ts": 12.4,
  "audit/internal/audit.test.ts": 11.9,
  "ingestion/statement-processing.test.ts": 11.5,
  "email-authentication/retention.test.ts": 11,
  "insights/weekly-runtime.test.ts": 9.8,
  "onboarding/verified-onboarding.test.ts": 9.6,
  "insights/reminder-schedule.test.ts": 9.3,
  "consent/proactivity-consent.test.ts": 9,
  "whatsapp/insight-delivery.test.ts": 8.2,
  "insights/reminder-canonical.test.ts": 7.6,
  "subscription/daviplata-migration.test.ts": 7.6,
  "subscription/refund-support.test.ts": 6.5,
  "agent/proactive-transcript.test.ts": 5.9,
  "insights/weekly-summary.test.ts": 5.6,
  "subscription/billing-collection.test.ts": 4.3,
  "agent/proactivity-choice.test.ts": 4,
  "core-http/internal/session-clock.test.ts": 3.9,
  "transactions/peer-reads.test.ts": 3.7,
  "insights/governor.test.ts": 3.5,
  "consent/weekly-consent.test.ts": 3.3,
  "audit/internal/reminder-audit-migration.test.ts": 3,
  "subscription/subscription-queries.test.ts": 2.4,
  "runtime/operational-health/alert-delivery.test.ts": 2.3,
  "ingestion/media-submissions.test.ts": 1.8,
  "resource-admission/resource-admission.test.ts": 1.7,
  "ingestion/statement-document.test.ts": 1.5,
  "ai/workers-ai.test.ts": 1.4,
  "ingestion/forwarding-address.test.ts": 1.3,
  "subscription/payment-enrollment-claim.test.ts": 1.3,
  "recovery/support-recovery.test.ts": 1.2,
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
