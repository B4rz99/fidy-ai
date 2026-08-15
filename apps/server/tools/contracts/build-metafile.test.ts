import { expect, it } from "vitest";
import { decodeBuildMetafile } from "../../scripts/build-metafile";

it("decodes the input map from a browser-client build metafile", () => {
  expect(Object.keys(decodeBuildMetafile({ inputs: { "src/client.ts": {} } }).inputs)).toEqual([
    "src/client.ts",
  ]);
});

it("rejects malformed browser-client build metafiles at the build boundary", () => {
  for (const malformed of [null, [], { inputs: null }, { inputs: [] }, "{", '{"inputs":[]}']) {
    expect(() => decodeBuildMetafile(malformed)).toThrow("metafile");
  }
});
