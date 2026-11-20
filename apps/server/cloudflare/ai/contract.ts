import { Data } from "effect";

export type OpenAiEnvironment = Readonly<{
  OPENAI_API_KEY: string;
  HOSTED_AI_MODEL: string;
}>;

export class OpenAiAdmissionUnavailable extends Data.TaggedError("OpenAiAdmissionUnavailable") {}
