import { gunzipSync } from "node:zlib";
import { Option } from "effect";
import { Tiktoken } from "js-tiktoken/lite";
import { ministral3bVocabulary } from "./fixtures/ministral-3b-2512-vocabulary";

/** Explicit non-empty v13 conversation shape supported by the Compaction probe. */
export type MistralV13Messages = readonly [
  system: Readonly<{ role: "system"; content: string }>,
  firstUser: Readonly<{ role: "user"; content: string }>,
  ...continuation: ReadonlyArray<
    Readonly<{ role: "system" | "user" | "assistant"; content: string }>
  >,
];

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
  messages: MistralV13Messages
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
 * Reproduces mistral-common v13 instruct framing for explicit system/User/assistant messages.
 * This does not claim that any hosted response-format metadata is free from prompt accounting.
 */
export const encodeMistralV13Messages = (messages: MistralV13Messages): ReadonlyArray<number> => {
  const normalized = normalizeMessages(messages);
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

/** Counts the pinned local v13 message representation without hosted request metadata. */
export const countMistralV13Messages = (messages: MistralV13Messages): number =>
  encodeMistralV13Messages(messages).length;
