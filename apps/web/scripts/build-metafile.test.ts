import { expect, it } from "vitest";
import { decodeBuildMetafile } from "./build-metafile";

it("decodes the input map from a build metafile", () => {
  expect(Object.keys(decodeBuildMetafile({ inputs: { "src/main.tsx": {} } }).inputs)).toEqual([
    "src/main.tsx",
  ]);
});

it("rejects malformed build metafiles at the build boundary", () => {
  for (const malformed of [null, [], { inputs: null }, { inputs: [] }, "{", '{"inputs":[]}']) {
    expect(() => decodeBuildMetafile(malformed)).toThrow("module graph");
  }
});
