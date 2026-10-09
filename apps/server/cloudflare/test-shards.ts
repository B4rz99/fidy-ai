// Successful Linux file test-body estimates from complete green run 37862580400.
// Changed confirmation and Hosted Turn fixtures retain their preceding costs conservatively.
// These are scheduling estimates, not equivalent-revision medians. Tiny and new files keep
// a one-second floor. All four existing shards and their three worker processes are unchanged.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "oauth-agents/oauth-confirmation.test.ts": 95.1,
  "oauth-agents/oauth-ingress.test.ts": 80.3,
  "agent/hosted-turn.test.ts": 94.0,
  "oauth-agents/oauth-canonical.test.ts": 61.3,
  "dashboard/dashboard.test.ts": 58.7,
  "oauth-agents/oauth-discovery.test.ts": 73.0,
  "transactions/transactions.test.ts": 61.4,
  "oauth-agents/oauth-refresh.test.ts": 43.2,
  "budgets/budgets.test.ts": 43.8,
  "ingestion/statement-ingestion.test.ts": 40.5,
  "recurring/recurring.test.ts": 48.8,
  "oauth-agents/oauth-allowance.test.ts": 29.0,
  "oauth-agents/oauth-native-residency.test.ts": 21.4,
  "oauth-agents/oauth-management.test.ts": 18.9,
  "subscription/weekly-renewal.test.ts": 24.0,
  "tokens/pats.test.ts": 42.0,
  "connections/connections.test.ts": 17.8,
  "insights/proactivity-runtime.test.ts": 17.7,
  "provider-authentication/whatsapp.test.ts": 19.9,
  "insights/recurring-digest.test.ts": 19.5,
  "subscription/daviplata-migration.test.ts": 18.3,
  "subscription/payment-enrollment.test.ts": 17.0,
  "provider-authentication/microsoft.test.ts": 11.9,
  "provider-authentication/journey.test.ts": 11.1,
  "ingestion/statement-processing.test.ts": 12.9,
  "ingestion/forwarded-email.test.ts": 16.8,
  "memory/memory.test.ts": 11.0,
  "insights/weekly-runtime.test.ts": 8.0,
  "categories/keyword-rules.test.ts": 10.0,
  "canonical-admission/operations.test.ts": 16.9,
  "onboarding/browser-authentication.test.ts": 6.9,
  "transactions/oauth-review.test.ts": 10.2,
  "onboarding/consent-ingress.test.ts": 6.2,
  "weekly-workflow.test.ts": 8.2,
  "subscription/refunds.test.ts": 8.9,
  "insights/insight-store.test.ts": 5.5,
  "ingestion/statement-staging.test.ts": 7.3,
  "consent/proactivity-consent.test.ts": 5.3,
  "insights/reminder-canonical.test.ts": 4.8,
  "whatsapp/insight-delivery.test.ts": 4.3,
  "insights/governor.test.ts": 3.4,
  "oauth-agents/oauth-mcp-free.test.ts": 3.9,
  "runtime/operational-health/alert-delivery.test.ts": 3.2,
  "agent/proactive-transcript.test.ts": 4.1,
  "d1-test-fixture.test.ts": 3.2,
  "insights/weekly-summary.test.ts": 3.6,
  "subscription/billing-collection.test.ts": 3.7,
  "consent/weekly-consent.test.ts": 3.2,
  "email-authentication/retention.test.ts": 5.0,
  "resource-admission/resource-admission.test.ts": 3.7,
  "subscription/refund-support.test.ts": 2.8,
  "audit/internal/audit.test.ts": 5.1,
  "ingestion/media-submissions.test.ts": 2.6,
  "audit/internal/reminder-audit-migration.test.ts": 2.4,
  "core-http/internal/session-clock.test.ts": 2.6,
  "insights/reminder-schedule.test.ts": 3.3,
  "agent/proactivity-choice.test.ts": 3.5,
  "ingestion/forwarding-address.test.ts": 1.6,
  "transactions/peer-reads.test.ts": 3.6,
  "recovery/support-recovery.test.ts": 1.4,
  "ingestion/statement-document.test.ts": 2.0,
  "access-tier.test.ts": 1,
  "agent/internal/exit-on-abort.test.ts": 1,
  "agent/working-context.test.ts": 1,
  "ai/admission.test.ts": 1,
  "ai/retention.test.ts": 1,
  "ai/workers-ai-conformance-worker.test.ts": 1,
  "ai/workers-ai.test.ts": 1.5,
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
  "runtime/runtime.test.ts": 1,
  "runtime/telemetry.test.ts": 1,
  "subscription/daviplata-sandbox.test.ts": 1,
  "subscription/internal/billing-rules.test.ts": 1,
  "subscription/internal/wompi-billing-client.test.ts": 1,
  "subscription/internal/wompi-client.test.ts": 1,
  "subscription/payment-enrollment-claim.test.ts": 1,
  "subscription/payment-enrollment-migration.test.ts": 1,
  "subscription/subscription-queries.test.ts": 1.2,
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
