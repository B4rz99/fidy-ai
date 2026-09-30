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
    return Promise.resolve(files);
  }
}
