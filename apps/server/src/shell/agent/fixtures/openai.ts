import { UnknownJsonString } from "~/schema-compatibility";
import { Schema } from "effect";

const makeOpenAiResponse = (output: ReadonlyArray<unknown>): string =>
  Schema.encodeSync(UnknownJsonString)({
    id: "resp_test",
    object: "response",
    created_at: 0,
    model: "gpt-5.6-luna",
    status: "completed",
    output,
    metadata: null,
    temperature: null,
    top_p: null,
    tools: [],
    tool_choice: "auto",
    error: null,
    incomplete_details: null,
    instructions: null,
    parallel_tool_calls: false,
  });

/** Builds a minimal completed Responses API text response for adapter tests. */
export const makeOpenAiTextResponse = (text: string): string =>
  makeOpenAiResponse([
    {
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    },
  ]);

/** Builds a completed Responses API function call for an assembled toolkit test. */
export const makeOpenAiFunctionCallResponse = ({
  name,
  argumentsJson,
}: Readonly<{ name: string; argumentsJson: string }>): string =>
  makeOpenAiResponse([
    {
      type: "function_call",
      id: "fc_test",
      call_id: "call_test",
      name,
      arguments: argumentsJson,
      status: "completed",
    },
  ]);
