import type { TestSpecification, Vitest } from "vitest/node";
import { cloudflareTestShards } from "./test-shards";

export class CloudflareTestSequencer {
  private readonly context: Vitest;

  constructor(context: Vitest) {
    this.context = context;
  }

  shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.context.config.shard;
    if (shard === undefined) return Promise.resolve(files);
    const shards = cloudflareTestShards({
      files: files.map((file) => file.moduleId),
      cloudflareRoot: new URL("./", import.meta.url).pathname,
      count: shard.count,
    });
    const selected = new Set(shards[shard.index - 1]);
    return Promise.resolve(files.filter((file) => selected.has(file.moduleId)));
  }

  sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Start long files first so a late long file cannot leave the other process idle.
    const ordered = cloudflareTestShards({
      files: files.map((file) => file.moduleId),
      cloudflareRoot: new URL("./", import.meta.url).pathname,
      count: 1,
    }).flat();
    const rank = new Map(ordered.map((moduleId, index) => [moduleId, index]));
    return Promise.resolve(
      [...files].sort(
        (left, right) => (rank.get(left.moduleId) ?? 0) - (rank.get(right.moduleId) ?? 0)
      )
    );
  }
}
