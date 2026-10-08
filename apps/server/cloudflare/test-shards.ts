// Single-run Linux CI file test-body estimates from complete green run 37858866790.
// Changed subscription/fixture costs use passed file results from run 37859634224;
// the failed OAuth file keeps its preceding successful cost. These are scheduling estimates,
// not equivalent-revision medians. Tiny and newly discovered files receive a one-second floor.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "oauth-agents/oauth-confirmation.test.ts": 98.1,
  "oauth-agents/oauth-ingress.test.ts": 83.2,
  "agent/hosted-turn.test.ts": 81.5,
  "oauth-agents/oauth-canonical.test.ts": 56.7,
  "dashboard/dashboard.test.ts": 53.8,
  "oauth-agents/oauth-discovery.test.ts": 53.2,
  "transactions/transactions.test.ts": 46.3,
  "oauth-agents/oauth-refresh.test.ts": 45.7,
  "budgets/budgets.test.ts": 41.9,
  "ingestion/statement-ingestion.test.ts": 41.1,
  "recurring/recurring.test.ts": 40.4,
  "oauth-agents/oauth-allowance.test.ts": 26.6,
  "oauth-agents/oauth-native-residency.test.ts": 22.9,
  "oauth-agents/oauth-management.test.ts": 22.4,
  "subscription/weekly-renewal.test.ts": 19.9,
  "tokens/pats.test.ts": 19.4,
  "connections/connections.test.ts": 18.2,
  "insights/proactivity-runtime.test.ts": 17.9,
  "provider-authentication/whatsapp.test.ts": 17.5,
  "insights/recurring-digest.test.ts": 16.8,
  "subscription/daviplata-migration.test.ts": 16.0,
  "subscription/payment-enrollment.test.ts": 15.6,
  "provider-authentication/microsoft.test.ts": 13.1,
  "provider-authentication/journey.test.ts": 10.5,
  "ingestion/statement-processing.test.ts": 10.4,
  "ingestion/forwarded-email.test.ts": 10.2,
  "memory/memory.test.ts": 9.8,
  "insights/weekly-runtime.test.ts": 9.5,
  "categories/keyword-rules.test.ts": 9.4,
  "canonical-admission/operations.test.ts": 9.2,
  "onboarding/browser-authentication.test.ts": 7.0,
  "transactions/oauth-review.test.ts": 6.8,
  "onboarding/consent-ingress.test.ts": 6.4,
  "weekly-workflow.test.ts": 6.2,
  "subscription/refunds.test.ts": 6.0,
  "insights/insight-store.test.ts": 5.4,
  "ingestion/statement-staging.test.ts": 4.7,
  "consent/proactivity-consent.test.ts": 4.3,
  "insights/reminder-canonical.test.ts": 4.2,
  "whatsapp/insight-delivery.test.ts": 4.0,
  "insights/governor.test.ts": 3.7,
  "oauth-agents/oauth-mcp-free.test.ts": 3.6,
  "runtime/operational-health/alert-delivery.test.ts": 3.6,
  "agent/proactive-transcript.test.ts": 3.5,
  "d1-test-fixture.test.ts": 3.5,
  "insights/weekly-summary.test.ts": 3.5,
  "subscription/billing-collection.test.ts": 3.5,
  "consent/weekly-consent.test.ts": 3.3,
  "email-authentication/retention.test.ts": 3.3,
  "resource-admission/resource-admission.test.ts": 3.3,
  "subscription/refund-support.test.ts": 3.1,
  "audit/internal/audit.test.ts": 2.9,
  "ingestion/media-submissions.test.ts": 2.9,
  "audit/internal/reminder-audit-migration.test.ts": 2.6,
  "core-http/internal/session-clock.test.ts": 2.3,
  "insights/reminder-schedule.test.ts": 2.3,
  "agent/proactivity-choice.test.ts": 2.1,
  "ingestion/forwarding-address.test.ts": 2.0,
  "transactions/peer-reads.test.ts": 1.9,
  "recovery/support-recovery.test.ts": 1.6,
  "ingestion/statement-document.test.ts": 1.2,
  "access-tier.test.ts": 1.0,
  "agent/internal/exit-on-abort.test.ts": 1.0,
  "agent/working-context.test.ts": 1.0,
  "ai/admission.test.ts": 1.0,
  "ai/retention.test.ts": 1.0,
  "ai/workers-ai-conformance-worker.test.ts": 1.0,
  "ai/workers-ai.test.ts": 1.0,
  "anonymous-admission/operations.test.ts": 1.0,
  "bancolombia-sandbox.test.ts": 1.0,
  "browser-login/operations.test.ts": 1.0,
  "categories/operations.test.ts": 1.0,
  "consent/operations.test.ts": 1.0,
  "documents/document-extraction-worker.test.ts": 1.0,
  "documents/document-parsing-worker.test.ts": 1.0,
  "email-authentication/ancillary-operations.test.ts": 1.0,
  "http/request-body.test.ts": 1.0,
  "identity/current-user.test.ts": 1.0,
  "identity/identity-owner.test.ts": 1.0,
  "identity/trial-period.test.ts": 1.0,
  "identity/user-context/operations.test.ts": 1.0,
  "ingestion/forwarded-email-delivery.test.ts": 1.0,
  "maintenance/schedule.test.ts": 1.0,
  "public-worker-cancellation.test.ts": 1.0,
  "queue/runtime.test.ts": 1.0,
  "quotas/operations.test.ts": 1.0,
  "runtime/operational-health/alerts.test.ts": 1.0,
  "runtime/operational-health/canary.test.ts": 1.0,
  "runtime/operational-health/event-metrics.test.ts": 1.0,
  "runtime/operational-health/health-view.test.ts": 1.0,
  "runtime/operational-health/health.test.ts": 1.0,
  "runtime/operational-health/operator-email.test.ts": 1.0,
  "runtime/operational-health/probes.test.ts": 1.0,
  "runtime/operational-health/workflow-failure.test.ts": 1.0,
  "runtime/release-smoke/admission.test.ts": 1.0,
  "runtime/runtime.test.ts": 1.0,
  "runtime/telemetry.test.ts": 1.0,
  "subscription/daviplata-sandbox.test.ts": 1.0,
  "subscription/internal/billing-rules.test.ts": 1.0,
  "subscription/internal/wompi-billing-client.test.ts": 1.0,
  "subscription/internal/wompi-client.test.ts": 1.0,
  "subscription/payment-enrollment-claim.test.ts": 1.0,
  "subscription/payment-enrollment-migration.test.ts": 1.0,
  "subscription/subscription-queries.test.ts": 1.0,
  "subscription/wompi-event.test.ts": 1.0,
  "test-shards.test.ts": 1.0,
  "tokens/retention.test.ts": 1.0,
  "transactions/ingestion-capture.test.ts": 1.0,
  "web-authentication/operations.test.ts": 1.0,
  "web-authentication/session-clock.test.ts": 1.0,
  "web-authentication/session-lifetime.test.ts": 1.0,
  "web-session/operations.test.ts": 1.0,
  "whatsapp/operations.test.ts": 1.0,
  "whatsapp/webhook-abort.test.ts": 1.0,
  "whatsapp/webhook-body.test.ts": 1.0,
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
