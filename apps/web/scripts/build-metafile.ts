import { Predicate, Schema } from "effect";

const BuildMetafile = Schema.Struct({
  inputs: Schema.Record(Schema.String, Schema.Unknown),
});

type BuildMetafile = typeof BuildMetafile.Type;

/** Returns Bun's web input graph, or throws when its object or JSON representation is malformed. */
export const decodeBuildMetafile = (value: unknown): BuildMetafile => {
  try {
    return Predicate.isString(value)
      ? Schema.decodeUnknownSync(Schema.fromJsonString(BuildMetafile))(value)
      : Schema.decodeUnknownSync(BuildMetafile)(value);
  } catch {
    throw new Error("Browser build did not return a module graph");
  }
};
