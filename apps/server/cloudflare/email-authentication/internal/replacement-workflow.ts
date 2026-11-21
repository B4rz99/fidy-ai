import { EmailReplacementWork as Work } from "../contract";
import { Option, Schema } from "effect";

export const isEmailReplacementWork = (value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Schema.Struct({ kind: Work.fields.kind }))(value));
