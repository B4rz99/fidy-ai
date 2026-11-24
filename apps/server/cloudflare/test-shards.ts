const estimatedSeconds = new Map(
  Object.entries({
    "transactions/transactions.test.ts": 185.03,
    "dashboard/user-store.test.ts": 74.94,
    "email-authentication/native-replacement.test.ts": 70.62,
    "categories/keyword-rules.test.ts": 63.02,
    "consent/browser.test.ts": 58.33,
    "email-authentication/native-login.test.ts": 56.22,
    "budgets/budgets.test.ts": 53.24,
    "queue/failure-isolation.test.ts": 46.26,
    "oauth-agents/native-grant.test.ts": 42.96,
    "transactions/user-store.test.ts": 39.23,
    "provider-authentication/microsoft.test.ts": 38.99,
    "agent/user-store.test.ts": 37.97,
    "core-http/browser-admission.test.ts": 37.83,
    "memory/memory.test.ts": 37.11,
    "ingestion/native-document.test.ts": 33.9,
    "connections/native-connections.test.ts": 33.32,
    "ingestion/native-email.test.ts": 33.17,
    "maintenance/monitoring-isolation.test.ts": 32.37,
    "email-authentication/native-redemption.test.ts": 31.58,
    "erasure/native-purge.test.ts": 28.95,
    "provider-authentication/native-provider.test.ts": 28.3,
    "provider-authentication/journey.test.ts": 27.73,
    "agent/native-turn-lifecycle.test.ts": 27.01,
    "oauth-agents/native-discovery.test.ts": 26.51,
    "dashboard/native-batches.test.ts": 26.3,
    "onboarding/consent-ingress.test.ts": 24.03,
    "subscription/native-enrollment.test.ts": 22.07,
    "ingestion/native-sample.test.ts": 21.36,
    "recurring/recurring.test.ts": 20.14,
    "budgets/user-store.test.ts": 19.54,
    "ingestion/native-statement-retention.test.ts": 19.41,
    "directory/bootstrap.test.ts": 18.96,
    "tokens/native-retention.test.ts": 18.81,
    "transactions/native-history-channels.test.ts": 17.94,
    "maintenance/watchdog-traversal.test.ts": 15.79,
    "canonical-operations/user-store.test.ts": 15.54,
    "ingestion/native-media.test.ts": 15.54,
    "provider-authentication/whatsapp-link-signup.test.ts": 14.96,
    "recurring-plans/user-store.test.ts": 14.92,
    "erasure/native-admission.test.ts": 14.76,
    "erasure/native-custody.test.ts": 13.85,
    "insights/native-reminder-consent.test.ts": 12.86,
    "subscription/cancellation-recovery.test.ts": 12.47,
    "oauth-agents/native-allowance.test.ts": 12.23,
    "agent/native-whatsapp-provider.test.ts": 12.08,
    "subscription/native-enrollment-erasure.test.ts": 11.7,
    "tokens/native-authority.test.ts": 11.53,
    "memory/user-store.test.ts": 11.36,
    "recovery/native-rotation.test.ts": 11.21,
    "storage-bootstrap/release.test.ts": 11.15,
    "maintenance/watchdog.test.ts": 11.03,
    "subscription/cancellation-journey.test.ts": 10.95,
    "insights/native-reminder.test.ts": 10.82,
    "tokens/native-pairing.test.ts": 10.67,
    "runtime/sqlite/migrations.test.ts": 10.65,
    "subscription/native-callback.test.ts": 10.4,
    "whatsapp/native-callback.test.ts": 9.92,
    "categories/taxonomy.test.ts": 9.45,
    "oauth-agents/native-ingestion-confirmation.test.ts": 8.72,
    "insights/native-category-opportunity.test.ts": 8.71,
    "subscription/native-refund.test.ts": 8.56,
    "subscription/pricing.test.ts": 7.95,
    "provider-authentication/admission.test.ts": 6.83,
    "recovery/native-support.test.ts": 6.63,
    "insights/user-store.test.ts": 6.33,
    "core-http/native-listings.test.ts": 6.3,
    "ingestion/native-review.test.ts": 6.16,
    "web-authentication/bound-user.test.ts": 5.96,
    "audit/native-retention.test.ts": 5.25,
    "agent/native-compaction.test.ts": 5.24,
    "oauth-agents/native-connections.test.ts": 5.06,
    "recovery/native-retention.test.ts": 5.03,
    "ingestion/native-review-authority.test.ts": 4.63,
    "maintenance/lifetime-registry.test.ts": 4.51,
    "budgets/native-thresholds.test.ts": 4.36,
    "identity/whatsapp-replacement.test.ts": 4.34,
    "ingestion/native-ingestion-batch.test.ts": 4.11,
    "transactions/native-privacy.test.ts": 3.84,
    "storage-bootstrap/transaction.test.ts": 3.72,
    "directory/pairing-isolation.test.ts": 3.57,
    "consent/native-browser.test.ts": 3.56,
    "maintenance/core-schedule.test.ts": 3.4,
    "core-http/native-initial-consent.test.ts": 3.39,
    "core-http/internal/session-clock.test.ts": 3.26,
    "identity/preferences.test.ts": 3.17,
    "ingestion/native-forwarding.test.ts": 2.48,
    "queue/native-recovery.test.ts": 1.99,
    "documents/document-parsing-limits.test.ts": 1.81,
    "bancolombia-authentication/grant-cleanup.test.ts": 1.67,
    "recovery/support-recovery.test.ts": 1.43,
    "bancolombia-authentication/token-lifecycle.test.ts": 0.91,
    "ai/openai-conformance-worker.test.ts": 0.8,
    "runtime/sqlite/capacity.test.ts": 0.75,
    "bancolombia-authentication/authorization.test.ts": 0.61,
    "bancolombia-authentication/authentication.test.ts": 0.5,
    "documents/durable-parser-proof-worker.test.ts": 0.47,
    "ai/adversarial-evaluation.test.ts": 0.41,
    "core-http/runtime.test.ts": 0.4,
    "provider-authentication/transport-runtime.test.ts": 0.36,
    "subscription/internal/wompi-client.test.ts": 0.35,
    "runtime/telemetry.test.ts": 0.32,
    "bancolombia-authentication/activation.test.ts": 0.23,
    "cli-distribution.test.ts": 0.2,
    "ingestion/statement-review-budget.test.ts": 0.15,
    "subscription/internal/wompi-billing-client.test.ts": 0.15,
    "documents/document-parsing-worker.test.ts": 0.14,
    "documents/document-extraction-worker.test.ts": 0.12,
    "public-worker-mcp.test.ts": 0.12,
    "budgets/workspace-encoding.test.ts": 0.08,
    "public-worker-hosted-recovery.test.ts": 0.07,
    "bancolombia-sandbox.test.ts": 0.06,
    "outbound-http/runtime.test.ts": 0.06,
    "public-worker-browser-entry.test.ts": 0.06,
    "public-worker-cancellation.test.ts": 0.06,
    "anonymous-admission/operations.test.ts": 0.05,
    "http/request-body.test.ts": 0.05,
    "maintenance/schedule.test.ts": 0.05,
    "public-worker-telemetry.test.ts": 0.05,
    "subscription/daviplata-sandbox.test.ts": 0.05,
    "subscription/wompi-event.test.ts": 0.05,
    "budgets/budget-row.test.ts": 0.04,
    "public-worker-erasure.test.ts": 0.04,
    "agent/internal/exit-on-abort.test.ts": 0.03,
    "bancolombia-authentication/runtime.test.ts": 0.03,
    "ingestion/forwarded-email-delivery.test.ts": 0.03,
    "mcp/internal/native-reader.test.ts": 0.03,
    "runtime/application-observation/operations.test.ts": 0.03,
    "subscription/internal/billing-rules.test.ts": 0.03,
    "agent/working-context.test.ts": 0.02,
    "queue/runtime.test.ts": 0.02,
    "runtime/operational-health/canary.test.ts": 0.02,
    "runtime/operational-health/core-rejection.test.ts": 0.02,
    "secret-material/operations.test.ts": 0.02,
    "transactions/internal/recovery-alarm.test.ts": 0.02,
    "canonical-admission/response-timing.test.ts": 0.01,
    "mcp/native-catalog.test.ts": 0.01,
    "runtime/operational-health/alerts.test.ts": 0.01,
    "test-shards.test.ts": 0.01,
    "whatsapp/webhook-abort.test.ts": 0.01,
    "whatsapp/webhook-body.test.ts": 0.01,
  })
);

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
    estimatedSeconds.get(file.replaceAll("\\", "/").slice(prefix.length)) ?? 1;

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
