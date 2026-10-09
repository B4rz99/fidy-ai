import { expect, it } from "vitest";
import { cloudflareTestShards } from "./test-shards";

const root = "/repo/cloudflare";
const file = (name: string): string => `${root}/${name}.test.ts`;

it("separates the two slowest suites and fills spare capacity with smaller suites", () => {
  const transactions = file("transactions/transactions");
  const statements = file("ingestion/statement-ingestion");
  const dashboard = file("dashboard/dashboard");
  const pats = file("tokens/pats");
  expect(
    cloudflareTestShards({
      files: [pats, dashboard, statements, transactions],
      cloudflareRoot: root,
      count: 2,
    })
  ).toEqual([
    [transactions, statements],
    [dashboard, pats],
  ]);
});

it("assigns new and measured files exactly once regardless of discovery order", () => {
  const files = [file("new-feature"), file("transactions/transactions"), file("another-feature")];
  for (const count of [1, 2, 3, 4, 8]) {
    const shards = cloudflareTestShards({ files, cloudflareRoot: root, count });
    expect(shards).toHaveLength(count);
    expect(shards).toEqual(
      cloudflareTestShards({ files: [...files].reverse(), cloudflareRoot: root, count })
    );
    expect(shards.flat().sort()).toEqual([...files].sort());
  }
});

it("orders the entire discovered suite longest-first when only one shard is requested", () => {
  const files = [file("new-feature"), file("transactions/transactions")];
  const shards = cloudflareTestShards({ files, cloudflareRoot: root, count: 1 });
  expect(shards).toHaveLength(1);
  expect(shards.flat()).toEqual([file("transactions/transactions"), file("new-feature")]);
});
