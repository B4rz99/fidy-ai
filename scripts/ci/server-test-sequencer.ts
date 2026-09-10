import { BaseSequencer, type TestSpecification } from "vitest/node";
import { serverTestTimings } from "./server-test-timings";

const measuredSeconds = new Map(
  Object.entries(serverTestTimings).map(([path, seconds]) => [path, Number(seconds)])
);
const bytesPerFallbackWeight = 50_000;

type WeightedFile<A> = {
  readonly file: A;
  readonly id: string;
  readonly weight: number;
};

type Shard<A> = {
  readonly files: Array<WeightedFile<A>>;
  weight: number;
};

/** Assigns every file once using deterministic longest-processing-time scheduling. */
export const assignServerTestShards = <A>({
  files,
  shardCount,
}: Readonly<{
  files: ReadonlyArray<WeightedFile<A>>;
  shardCount: number;
}>): ReadonlyArray<ReadonlyArray<A>> => {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error("shardCount must be a positive safe integer");
  }
  const shards: Array<Shard<A>> = Array.from({ length: shardCount }, () => ({
    files: [],
    weight: 0,
  }));
  const ordered = [...files].sort(
    (left, right) => right.weight - left.weight || left.id.localeCompare(right.id)
  );
  for (const file of ordered) {
    const lightest = shards.reduce((selected, candidate) =>
      candidate.weight < selected.weight ? candidate : selected
    );
    lightest.files.push(file);
    lightest.weight += file.weight;
  }
  return shards.map((shard) => shard.files.map(({ file }) => file));
};

/** Balances CI shards from measured outliers, using source size for new test files. */
export class ServerTestSequencer extends BaseSequencer {
  override shard(files: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const shard = this.ctx.config.shard;
    if (shard === undefined) return Promise.resolve(files);
    const rootPrefix = `${this.ctx.config.root.replace(/\/$/u, "")}/`;
    const weighted = files.map((file): WeightedFile<TestSpecification> => {
      const id = file.moduleId.startsWith(rootPrefix)
        ? file.moduleId.slice(rootPrefix.length)
        : file.moduleId;
      return {
        file,
        id,
        weight:
          measuredSeconds.get(id) ??
          Math.max(1, Bun.file(file.moduleId).size / bytesPerFallbackWeight),
      };
    });
    const selected = assignServerTestShards({ files: weighted, shardCount: shard.count })[
      shard.index - 1
    ];
    if (selected === undefined) throw new Error(`Invalid server test shard index: ${shard.index}`);
    return Promise.resolve([...selected]);
  }
}
