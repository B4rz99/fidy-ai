import { BrowserPairingEmailWork as Work } from "../contract";
import { Option, Schema } from "effect";

export const isBrowserPairingEmailWork = (value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Schema.Struct({ kind: Work.fields.kind }))(value));
