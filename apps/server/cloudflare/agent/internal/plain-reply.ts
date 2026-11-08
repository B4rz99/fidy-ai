import { Option, Schema } from "effect";
import { TranscriptText } from "../../../src/core/agent/contract";

const quotedReply = Schema.fromJsonString(
  Schema.Struct({
    source: Schema.Literals(["transcript_assistant", "active_request"]),
    text: TranscriptText,
  })
);

const unpackReply = (text: string): string =>
  Option.match(Schema.decodeOption(quotedReply)(text), {
    onNone: () => text,
    onSome: (reply) => reply.text,
  });
const stripFormatting = (text: string): string =>
  text
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*```[^\n]*\n?/gmu, "")
    .replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/gu, "$1")
    .replace(/__(\S(?:[^_]*?\S)?)__/gu, "$1")
    .replace(/(?<!\w)\*(\S(?:[^*\n]*?\S)?)\*(?!\w)/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/^\s*\*\s+/gmu, "- ")
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/gu, "$1: $2")
    .trim();
export const plainReply = (text: TranscriptText): TranscriptText => {
  const plain = stripFormatting(unpackReply(stripFormatting(unpackReply(text))));
  return Option.getOrElse(Schema.decodeOption(TranscriptText)(plain), () => text);
};
