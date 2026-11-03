import { Schema } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import {
  ApprovedOpenAiModel,
  type OpenAiTransportRun,
} from "../src/shell/hosted-inference/contract";

const FunctionCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});
const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literals(["system", "user"]), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: Schema.optionalKey(Schema.Array(FunctionCall)),
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    content: Schema.String,
    tool_call_id: Schema.String,
  }),
]);
const Base = Schema.Struct({
  model: ApprovedOpenAiModel,
  messages: Schema.Array(Message),
  max_completion_tokens: Schema.Finite,
  temperature: Schema.Literal(0),
  stream: Schema.Literal(false),
  reasoning_effort: Schema.Literal("none"),
  store: Schema.Literal(false),
});
const WireRequest = Schema.Union([
  Base.mapFields((fields) => ({
    ...fields,
    tool_choice: Schema.Literal("auto"),
    tools: Schema.Array(
      Schema.Struct({
        type: Schema.Literal("function"),
        function: Schema.Struct({
          name: Schema.String,
          description: Schema.String,
          parameters: Schema.Record(Schema.String, Schema.Unknown),
          strict: Schema.Literal(false),
        }),
      })
    ),
  })),
  Base.mapFields((fields) => ({
    ...fields,
    response_format: Schema.Struct({
      type: Schema.Literal("json_schema"),
      json_schema: Schema.Struct({
        name: Schema.String,
        schema: Schema.Record(Schema.String, Schema.Unknown),
        strict: Schema.Literal(true),
      }),
    }),
  })),
  Base,
]);

const providers = new Map<string, OpenAiTransportRun>();
let sequence = 0;

export const openAiTestKey = (binding: Readonly<{ run: OpenAiTransportRun }>): string => {
  sequence += 1;
  const key = `synthetic-openai-${sequence}`;
  providers.set(key, binding.run);
  return key;
};

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const withOpenAiFetch = (fallback: FetchHandler): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const destination = input instanceof Request ? input.url : String(input);
      if (destination !== "https://api.openai.com/v1/chat/completions") {
        return fallback(input, init);
      }
      const request = new Request(input, init);
      const key = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
      const run = providers.get(key);
      if (run === undefined) {
        return Promise.reject(new Error("Unconfigured synthetic OpenAI transport"));
      }
      return request.text().then((body) => {
        const { model, ...inference } = Schema.decodeSync(Schema.fromJsonString(WireRequest))(body);
        return run(model, inference, { signal: request.signal });
      });
    },
    { preconnect: globalThis.fetch.preconnect }
  );

beforeEach(() => vi.stubGlobal("fetch", withOpenAiFetch(globalThis.fetch)));
afterEach(() => vi.unstubAllGlobals());
