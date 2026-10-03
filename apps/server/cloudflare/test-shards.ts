// Linux test-file seconds from Checks run 36658908035; see docs/ci-performance.md.
// Relative weights only. Every discovered file is assigned, including new files
// without a measurement; refresh from the preserved CI timing artifacts as suites change.
const estimatedSeconds: Readonly<Record<string, number>> = {
  "transactions/transactions.test.ts": 49.6,
  "ingestion/statement-ingestion.test.ts": 41.9,
  "agent/hosted-turn.test.ts": 35.8,
  "dashboard/dashboard.test.ts": 10.9,
  "tokens/pats.test.ts": 15.4,
  "ingestion/statement-processing.test.ts": 6.2,
  "budgets/budgets.test.ts": 13.7,
  "insights/insight-store.test.ts": 10.2,
  "categories/keyword-rules.test.ts": 9.5,
  "memory/memory.test.ts": 7.4,
  "onboarding/consent-ingress.test.ts": 15.8,
  "ingestion/forwarded-email.test.ts": 11.1,
  "onboarding/verified-onboarding.test.ts": 11.6,
  "ingestion/statement-staging.test.ts": 3.5,
  "subscription/billing-collection.test.ts": 4.8,
  "subscription/payment-enrollment.test.ts": 4,
  "subscription/payment-enrollment-migration.test.ts": 4,
  "resource-admission/resource-admission.test.ts": 3.1,
  "runtime/operational-health/alert-delivery.test.ts": 1.4,
  "subscription/subscription-queries.test.ts": 1.3,
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
