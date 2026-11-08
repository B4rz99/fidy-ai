import { Option, Schema } from "effect";
import { TranscriptText } from "../../../src/core/agent/contract";

const quotedReply = Schema.fromJsonString(
  Schema.Struct({
    source: Schema.Literals(["transcript_assistant", "active_request"]),
    text: TranscriptText,
  })
);

export const plainReply = (text: TranscriptText): TranscriptText => {
  const quoted = Schema.decodeOption(quotedReply)(text);
  const content = Option.isSome(quoted) ? quoted.value.text : text;
  const plain = content
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*```[^\n]*\n?/gmu, "")
    .replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/gu, "$1")
    .replace(/__(\S(?:[^_]*?\S)?)__/gu, "$1")
    .replace(/(?<!\w)\*(\S(?:[^*\n]*?\S)?)\*(?!\w)/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/^\s*\*\s+/gmu, "- ")
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/gu, "$1: $2")
    .trim();
  return Option.getOrElse(Schema.decodeOption(TranscriptText)(plain), () => text);
};
