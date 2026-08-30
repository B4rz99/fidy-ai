import { Predicate, Schema } from "effect";

const BuildImport = Schema.Struct({
  path: Schema.String,
  kind: Schema.String,
});

const BuildOutput = Schema.Struct({
  entryPoint: Schema.optionalKey(Schema.String),
  imports: Schema.Array(BuildImport),
  inputs: Schema.Record(Schema.String, Schema.Unknown),
});

const BuildMetafile = Schema.Struct({
  inputs: Schema.Record(Schema.String, Schema.Unknown),
  outputs: Schema.optionalKey(Schema.Record(Schema.String, BuildOutput)),
});

export type BuildMetafile = typeof BuildMetafile.Type;

/** Returns Bun's web input graph, or throws when its object or JSON representation is malformed. */
export const decodeBuildMetafile = (value: unknown): BuildMetafile => {
  try {
    return Predicate.isString(value)
      ? Schema.decodeSync(Schema.fromJsonString(BuildMetafile))(value)
      : Schema.decodeUnknownSync(BuildMetafile)(value);
  } catch {
    throw new Error("Browser build did not return a module graph");
  }
};
