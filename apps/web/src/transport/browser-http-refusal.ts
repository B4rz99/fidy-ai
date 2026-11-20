import { ResourceLimited } from "@fidy/server/browser-http";
import { Option, Schema } from "effect";

export const isUnadmittedResourceRefusal = (value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Schema.toCodecJson(ResourceLimited))(value));
