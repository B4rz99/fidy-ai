import { expect, it } from "vitest";
import { cloudflareTestShards } from "./test-shards";

const root = "/repo/cloudflare";
const file = (name: string): string => `${root}/${name}.test.ts`;

it("separates the two slowest suites and fills spare capacity with smaller suites", () => {
  const transactions = file("transactions/transactions");
  const statements = file("ingestion/statement-ingestion");
  const dashboard = file("dashboard/dashboard");
  const pats = file("pats/pats");
  expect(
    cloudflareTestShards({
      files: [pats, dashboard, statements, transactions],
      cloudflareRoot: root,
      count: 2,
    })
  ).toEqual([
    [transactions, dashboard],
    [statements, pats],
  ]);
});

it("assigns new and measured files exactly once regardless of discovery order", () => {
  const files = [file("new-feature"), file("transactions/transactions"), file("another-feature")];
  const shards = cloudflareTestShards({ files, cloudflareRoot: root, count: 4 });
  expect(shards).toEqual(
    cloudflareTestShards({ files: [...files].reverse(), cloudflareRoot: root, count: 4 })
  );
  expect(shards.flat().sort()).toEqual([...files].sort());
});

it("runs the entire discovered suite when only one shard is requested", () => {
  const files = [file("new-feature"), file("transactions/transactions")];
  expect(cloudflareTestShards({ files, cloudflareRoot: root, count: 1 })).toEqual([
    [files[1], files[0]],
  ]);
});
