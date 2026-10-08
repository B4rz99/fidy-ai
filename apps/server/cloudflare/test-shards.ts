// Single-run Linux cloud-worker estimates after native baseline restoration.
// Measurements use the existing three isolated file processes and include contention from
// other local validation. They schedule work; they are not equivalent-revision median
// performance evidence or GitHub runner timings. Refresh from final CI artifacts when available.
// Every discovered file is assigned, including new files without a measurement.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "oauth-agents/oauth-confirmation.test.ts": 84.6,
  "oauth-agents/oauth-ingress.test.ts": 66.0,
  "agent/hosted-turn.test.ts": 63.9,
  "oauth-agents/oauth-discovery.test.ts": 56.5,
  "transactions/transactions.test.ts": 50.1,
  "oauth-agents/oauth-canonical.test.ts": 46.2,
  "subscription/weekly-renewal.test.ts": 23.0,
  "dashboard/dashboard.test.ts": 43.2,
  "recurring/recurring.test.ts": 42.9,
  "subscription/payment-enrollment.test.ts": 16.0,
  "categories/keyword-rules.test.ts": 12.0,
  "oauth-agents/oauth-refresh.test.ts": 33.6,
  "budgets/budgets.test.ts": 28.5,
  "subscription/refunds.test.ts": 10.0,
  "memory/memory.test.ts": 12.0,
  "ingestion/statement-ingestion.test.ts": 27.5,
  "tokens/pats.test.ts": 22.8,
  "oauth-agents/oauth-allowance.test.ts": 22.7,
  "oauth-agents/oauth-management.test.ts": 18.9,
  "insights/proactivity-runtime.test.ts": 18.6,
  "provider-authentication/whatsapp.test.ts": 18.3,
  "subscription/daviplata-migration.test.ts": 17.4,
  "oauth-agents/oauth-native-residency.test.ts": 16.9,
  "connections/connections.test.ts": 16.4,
  "ingestion/forwarded-email.test.ts": 15.5,
  "insights/recurring-digest.test.ts": 14.7,
  "canonical-admission/operations.test.ts": 13.0,
  "provider-authentication/microsoft.test.ts": 11.3,
  "subscription/refund-support.test.ts": 3.0,
  "subscription/billing-collection.test.ts": 4.0,
  "ingestion/statement-processing.test.ts": 10.5,
  "provider-authentication/journey.test.ts": 9.9,
  "transactions/oauth-review.test.ts": 8.0,
  "insights/weekly-runtime.test.ts": 7.6,
  "onboarding/browser-authentication.test.ts": 7.3,
  "weekly-workflow.test.ts": 6.1,
  "onboarding/consent-ingress.test.ts": 5.5,
  "insights/insight-store.test.ts": 4.8,
  "audit/internal/audit.test.ts": 4.2,
  "consent/proactivity-consent.test.ts": 3.9,
  "email-authentication/retention.test.ts": 3.8,
  "whatsapp/insight-delivery.test.ts": 3.8,
  "ingestion/statement-staging.test.ts": 3.5,
  "subscription/subscription-queries.test.ts": 3.0,
  "d1-test-fixture.test.ts": 3.5,
  "insights/reminder-schedule.test.ts": 3.1,
  "agent/proactive-transcript.test.ts": 3.0,
  "insights/reminder-canonical.test.ts": 3.0,
  "insights/governor.test.ts": 2.8,
  "transactions/peer-reads.test.ts": 2.7,
  "ingestion/media-submissions.test.ts": 2.6,
  "runtime/operational-health/alert-delivery.test.ts": 2.6,
  "agent/proactivity-choice.test.ts": 2.5,
  "resource-admission/resource-admission.test.ts": 2.4,
  "insights/weekly-summary.test.ts": 2.3,
  "consent/weekly-consent.test.ts": 2.2,
  "subscription/payment-enrollment-claim.test.ts": 2.0,
  "audit/internal/reminder-audit-migration.test.ts": 1.8,
  "ai/workers-ai.test.ts": 1.6,
  "ingestion/forwarding-address.test.ts": 1.6,
  "ingestion/statement-document.test.ts": 1.6,
  "core-http/internal/session-clock.test.ts": 1.5,
  "recovery/support-recovery.test.ts": 1.5,
  "runtime/runtime.test.ts": 0.7,
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
