import { Data } from "effect";

/** Core configuration required to construct OpenAI hosted inference. */
export type OpenAiEnvironment = Readonly<{
  OPENAI_API_KEY: string;
  HOSTED_AI_MODEL: string;
}>;

/** OpenAI admission retention failed without exposing database or inference evidence. */
export class OpenAiAdmissionUnavailable extends Data.TaggedError("OpenAiAdmissionUnavailable") {}
