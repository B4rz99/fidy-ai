import { describe, expect, it } from "vitest";
import { assignServerTestShards } from "./server-test-sequencer";

const weighted = (id: string, weight: number): { file: string; id: string; weight: number } => ({
  file: id,
  id,
  weight,
});

describe("server test shard assignment", () => {
  it("assigns every file exactly once and balances measured duration", () => {
    const shards = assignServerTestShards({
      files: [
        weighted("slow", 9),
        weighted("medium", 5),
        weighted("small-a", 2),
        weighted("small-b", 2),
      ],
      shardCount: 2,
    });

    expect(shards).toEqual([["slow"], ["medium", "small-a", "small-b"]]);
    expect(shards.flat().sort()).toEqual(["medium", "slow", "small-a", "small-b"]);
  });

  it("uses file identity to make equal-weight assignments deterministic", () => {
    const files = [weighted("c", 1), weighted("a", 1), weighted("b", 1)];

    expect(assignServerTestShards({ files, shardCount: 2 })).toEqual([["a", "c"], ["b"]]);
    expect(assignServerTestShards({ files: [...files].reverse(), shardCount: 2 })).toEqual([
      ["a", "c"],
      ["b"],
    ]);
  });

  it("rejects an invalid shard count before dropping files", () => {
    expect(() => assignServerTestShards({ files: [weighted("a", 1)], shardCount: 0 })).toThrow(
      "shardCount must be a positive safe integer"
    );
  });
});
