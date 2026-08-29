import { jsonStringSchema } from "../src/schema-compatibility";
import { Predicate, Schema } from "effect";

const BuildMetafile = Schema.Struct({
  inputs: Schema.Record(Schema.String, Schema.Unknown),
});

type BuildMetafile = typeof BuildMetafile.Type;

/** Returns Bun's browser-client input graph, or throws when its object or JSON representation is malformed. */
export const decodeBuildMetafile = (value: unknown): BuildMetafile => {
  try {
    return Predicate.isString(value)
      ? Schema.decodeSync(jsonStringSchema(BuildMetafile))(value)
      : Schema.decodeUnknownSync(BuildMetafile)(value);
  } catch {
    throw new Error("Browser client build did not return a metafile");
  }
};
