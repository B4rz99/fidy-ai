import { gunzipSync } from "node:zlib";
import { type JsonSchema, Option } from "effect";
import { Tiktoken } from "js-tiktoken/lite";
import { ministral3bVocabulary } from "./fixtures/ministral-3b-2512-vocabulary";

/** Hosted text roles reproduced by the Ministral 3 v13 Compaction request. */
export type MistralStructuredMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

/** Exact count-bearing portion of one hosted strict structured request. */
export type MistralStructuredCountedRequest = Readonly<{
  messages: ReadonlyArray<MistralStructuredMessage>;
  /** Enforced by hosted constrained decoding; Mistral usage does not charge it as prompt tokens. */
  response_format: Readonly<{
    type: "json_schema";
    json_schema: Readonly<{
      name: string;
      strict: true;
      schema: JsonSchema.JsonSchema;
    }>;
  }>;
}>;

const tekkenPattern =
  "[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

const bpeRanks = gunzipSync(Buffer.from(ministral3bVocabulary.gzipBase64, "base64")).toString(
  "utf8"
);
const tokenizer = new Tiktoken({
  pat_str: tekkenPattern,
  special_tokens: {},
  bpe_ranks: bpeRanks,
});

const beginningOfSequence = 1;
const endOfSequence = 2;
const beginningOfInstruction = 3;
const endOfInstruction = 4;
const beginningOfSystem = 17;
const endOfSystem = 18;
const messageSeparator = "\n\n";

type ConversationMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

const normalizeMessages = (
  messages: ReadonlyArray<MistralStructuredMessage>
): Readonly<{
  system: Option.Option<string>;
  conversation: ReadonlyArray<ConversationMessage>;
}> => {
  const system = messages
    .filter((message) => message.role === "system" && message.content.length > 0)
    .map((message) => message.content)
    .join(messageSeparator);
  const conversation: Array<ConversationMessage> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const previous = conversation.at(-1);
    if (previous?.role === message.role) {
      conversation[conversation.length - 1] = {
        role: message.role,
        content: `${previous.content}${messageSeparator}${message.content}`,
      };
    } else {
      conversation.push({ role: message.role, content: message.content });
    }
  }
  return { system: Option.liftPredicate(system, (text) => text.length > 0), conversation };
};

const encodeText = (text: string): ReadonlyArray<number> => tokenizer.encode(text);

/**
 * Encodes exactly the v13 system/User/assistant representation submitted for strict Compaction.
 * The strict JSON Schema remains in the HTTP request but is absent from hosted prompt usage.
 */
export const encodeMistralStructuredRequest = (
  request: MistralStructuredCountedRequest
): ReadonlyArray<number> => {
  const normalized = normalizeMessages(request.messages);
  const tokens: Array<number> = [beginningOfSequence];
  if (Option.isSome(normalized.system)) {
    tokens.push(beginningOfSystem, ...encodeText(normalized.system.value), endOfSystem);
  }
  for (const message of normalized.conversation) {
    if (message.role === "user") {
      tokens.push(beginningOfInstruction, ...encodeText(message.content), endOfInstruction);
    } else {
      tokens.push(...encodeText(message.content), endOfSequence);
    }
  }
  return tokens;
};

/** Counts provider-reported prompt usage for one strict Ministral structured request. */
export const countMistralStructuredRequest = (request: MistralStructuredCountedRequest): number =>
  encodeMistralStructuredRequest(request).length;
