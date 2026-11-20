import { jsonStringSchema } from "../src/shell/schema-codecs/contract";
import { Predicate, Schema } from "effect";

const BuildMetafile = Schema.Struct({
  inputs: Schema.Record(Schema.String, Schema.Unknown),
});

type BuildMetafile = typeof BuildMetafile.Type;

export const decodeBuildMetafile = (value: unknown): BuildMetafile => {
  try {
    return Predicate.isString(value)
      ? Schema.decodeSync(jsonStringSchema(BuildMetafile))(value)
      : Schema.decodeUnknownSync(BuildMetafile)(value);
  } catch {
    throw new Error("Browser client build did not return a metafile");
  }
};
