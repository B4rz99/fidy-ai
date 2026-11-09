import { ResourceLimited } from "@fidy/server/browser-http";
import { Option, Schema } from "effect";

/** The original complete refusal codec is needed only before considering an automatic replay. */
export const isUnadmittedResourceRefusal = (value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Schema.toCodecJson(ResourceLimited))(value));
