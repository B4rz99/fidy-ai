// Median passed-file costs from complete green Linux runs 38347174706,
// 38347619527 and 38348015187. Multiple samples dampen single-run contention.
// Mixed-revision scheduling estimates, not controlled performance benchmarks.
// Tiny and newly discovered files keep a one-second floor. Shards and workers are unchanged.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "oauth-agents/oauth-confirmation.test.ts": 94.3,
  "oauth-agents/oauth-ingress.test.ts": 80.9,
  "agent/hosted-turn.test.ts": 63.5,
  "oauth-agents/oauth-canonical.test.ts": 45.9,
  "dashboard/dashboard.test.ts": 55.4,
  "oauth-agents/oauth-discovery.test.ts": 61.1,
  "transactions/transactions.test.ts": 65.3,
  "oauth-agents/oauth-refresh.test.ts": 45.3,
  "budgets/budgets.test.ts": 34.0,
  "ingestion/statement-ingestion.test.ts": 42.5,
  "recurring/recurring.test.ts": 50.6,
  "oauth-agents/oauth-allowance.test.ts": 19.0,
  "oauth-agents/oauth-native-residency.test.ts": 19.8,
  "oauth-agents/oauth-management.test.ts": 21.9,
  "subscription/weekly-renewal.test.ts": 23.9,
  "tokens/pats.test.ts": 35.3,
  "connections/connections.test.ts": 15.3,
  "insights/proactivity-runtime.test.ts": 12.1,
  "provider-authentication/whatsapp.test.ts": 78.6,
  "insights/recurring-digest.test.ts": 18.1,
  "subscription/daviplata-migration.test.ts": 16.1,
  "subscription/payment-enrollment.test.ts": 14.3,
  "provider-authentication/microsoft.test.ts": 14.5,
  "provider-authentication/journey.test.ts": 12.6,
  "ingestion/statement-processing.test.ts": 53.0,
  "ingestion/forwarded-email.test.ts": 14.6,
  "memory/memory.test.ts": 6.8,
  "insights/weekly-runtime.test.ts": 8.6,
  "categories/keyword-rules.test.ts": 9.8,
  "canonical-admission/operations.test.ts": 9.5,
  "onboarding/browser-authentication.test.ts": 6.5,
  "transactions/oauth-review.test.ts": 10.6,
  "onboarding/consent-ingress.test.ts": 4.5,
  "weekly-workflow.test.ts": 6.1,
  "subscription/refunds.test.ts": 8.6,
  "insights/insight-store.test.ts": 4.7,
  "ingestion/statement-staging.test.ts": 5.1,
  "consent/proactivity-consent.test.ts": 3.2,
  "insights/reminder-canonical.test.ts": 4.1,
  "whatsapp/insight-delivery.test.ts": 4.5,
  "insights/governor.test.ts": 3.7,
  "oauth-agents/oauth-mcp-free.test.ts": 3.2,
  "runtime/operational-health/alert-delivery.test.ts": 13.1,
  "agent/proactive-transcript.test.ts": 3.3,
  "d1-test-fixture.test.ts": 2.4,
  "insights/weekly-summary.test.ts": 3.3,
  "subscription/billing-collection.test.ts": 2.8,
  "consent/weekly-consent.test.ts": 3.2,
  "email-authentication/retention.test.ts": 4.2,
  "resource-admission/resource-admission.test.ts": 3.0,
  "subscription/refund-support.test.ts": 3.2,
  "audit/internal/audit.test.ts": 5.1,
  "ingestion/media-submissions.test.ts": 2.6,
  "audit/internal/reminder-audit-migration.test.ts": 1.7,
  "core-http/internal/session-clock.test.ts": 2.7,
  "insights/reminder-schedule.test.ts": 4.4,
  "agent/proactivity-choice.test.ts": 3.7,
  "ingestion/forwarding-address.test.ts": 1.6,
  "transactions/peer-reads.test.ts": 2.0,
  "recovery/support-recovery.test.ts": 4.6,
  "ingestion/statement-document.test.ts": 1.9,
  "access-tier.test.ts": 1,
  "agent/internal/exit-on-abort.test.ts": 1,
  "agent/working-context.test.ts": 1,
  "ai/admission.test.ts": 1,
  "ai/retention.test.ts": 1,
  "ai/workers-ai-conformance-worker.test.ts": 1,
  "ai/workers-ai.test.ts": 1,
  "anonymous-admission/operations.test.ts": 1,
  "bancolombia-sandbox.test.ts": 1,
  "browser-login/operations.test.ts": 1,
  "categories/operations.test.ts": 1,
  "consent/operations.test.ts": 1,
  "documents/document-extraction-worker.test.ts": 1,
  "documents/document-parsing-worker.test.ts": 1,
  "email-authentication/ancillary-operations.test.ts": 1,
  "http/request-body.test.ts": 1,
  "identity/current-user.test.ts": 1,
  "identity/identity-owner.test.ts": 1,
  "identity/trial-period.test.ts": 1,
  "identity/user-context/operations.test.ts": 1,
  "ingestion/forwarded-email-delivery.test.ts": 1,
  "maintenance/schedule.test.ts": 1,
  "public-worker-cancellation.test.ts": 1,
  "queue/runtime.test.ts": 1,
  "quotas/operations.test.ts": 1,
  "runtime/operational-health/alerts.test.ts": 1,
  "runtime/operational-health/canary.test.ts": 1,
  "runtime/operational-health/event-metrics.test.ts": 1,
  "runtime/operational-health/health-view.test.ts": 1,
  "runtime/operational-health/health.test.ts": 1,
  "runtime/operational-health/operator-email.test.ts": 1,
  "runtime/operational-health/probes.test.ts": 1,
  "runtime/operational-health/workflow-failure.test.ts": 1,
  "runtime/release-smoke/admission.test.ts": 1,
  "runtime/runtime.test.ts": 3.0,
  "runtime/telemetry.test.ts": 1,
  "subscription/daviplata-sandbox.test.ts": 1,
  "subscription/internal/billing-rules.test.ts": 1,
  "subscription/internal/wompi-billing-client.test.ts": 1,
  "subscription/internal/wompi-client.test.ts": 1,
  "subscription/payment-enrollment-claim.test.ts": 1,
  "subscription/payment-enrollment-migration.test.ts": 1,
  "subscription/subscription-queries.test.ts": 1,
  "subscription/wompi-event.test.ts": 1,
  "test-shards.test.ts": 1,
  "tokens/retention.test.ts": 1,
  "transactions/ingestion-capture.test.ts": 1,
  "web-authentication/operations.test.ts": 1,
  "web-authentication/session-clock.test.ts": 1,
  "web-authentication/session-lifetime.test.ts": 1,
  "web-session/operations.test.ts": 1,
  "whatsapp/operations.test.ts": 1,
  "whatsapp/webhook-abort.test.ts": 1,
  "whatsapp/webhook-body.test.ts": 1,
  "agent/hosted-retention.test.ts": 12.4,
  "browser-cost/operations.test.ts": 1,
  "cli-distribution.test.ts": 1,
  "documents/document-parsing-limits.test.ts": 1.1,
  "documents/durable-parser-proof-worker.test.ts": 1,
  "ingestion/retention.test.ts": 3.4,
  "ingestion/statement-review-budget.test.ts": 1,
  "insights/operational-health.test.ts": 4.4,
  "maintenance/admission-retention.test.ts": 1.7,
  "maintenance/core-schedule.test.ts": 7.1,
  "maintenance/monitoring-isolation.test.ts": 13.4,
  "maintenance/performance.test.ts": 1,
  "provider-authentication/admission.test.ts": 3.3,
  "provider-authentication/transport-runtime.test.ts": 1,
  "public-worker-mcp.test.ts": 1,
  "queue/failure-isolation.test.ts": 4.0,
  "queue/native-recovery.test.ts": 2.4,
  "transactions/performance.test.ts": 1,
  "transactions/projection-write-costs.test.ts": 2.7,
  "transactions/query-costs.test.ts": 4.9,
  "transactions/search-costs.test.ts": 3.3,
  "whatsapp/retention.test.ts": 3.2,
  "whatsapp/whatsapp-work.test.ts": 1,
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
