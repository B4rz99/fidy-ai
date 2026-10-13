import { expect, it } from "vitest";
import { decodeBuildMetafile } from "./build-metafile";

it("rejects malformed build metafiles at the build boundary", () => {
  for (const malformed of [null, [], { inputs: null }, { inputs: [] }, "{", '{"inputs":[]}']) {
    expect(() => decodeBuildMetafile(malformed)).toThrow("module graph");
  }
});
