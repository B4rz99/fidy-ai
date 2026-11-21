import {
  CreateKeywordRuleInput,
  KeywordRuleId,
  UpdateKeywordRuleInput,
} from "../../../src/core/categories/contract";
import { NotFound } from "../../../src/shell/public-http/contract";
import { Effect, Option, Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";
import { pathId, readBoundedRequestBody } from "../../http/operations";
import { HTTP_NOT_FOUND, keywordRuleJsonHeaders } from "./keyword-rule-shared";

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});
const CreateInput = Schema.toCodecJson(CreateKeywordRuleInput);
const UpdateInput = Schema.toCodecJson(UpdateKeywordRuleInput);

const jsonResponse = (body: string, status: number): Response =>
  new Response(body, { headers: keywordRuleJsonHeaders, status });

export const keywordRuleUnknownId = (): Response =>
  jsonResponse(
    JSON.stringify(
      Schema.encodeSync(Schema.toCodecJson(NotFound))(
        NotFound.make({
          error: {
            code: "not_found",
            message: "No keyword rule with that id belongs to you.",
          },
          next: [],
        })
      )
    ),
    HTTP_NOT_FOUND
  );

export const keywordRuleInput = ({
  request,
  update,
}: Readonly<{ request: Request; update: boolean }>): Promise<
  Option.Option<CreateKeywordRuleInput>
> => {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return Promise.resolve(Option.none());
  }
  const input = update ? UpdateInput : CreateInput;
  return Effect.runPromise(readBoundedRequestBody(request, bodyPolicy))
    .then((bytes) => {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return Schema.decodeUnknownOption(input)(parsed);
    })
    .catch(() => Option.none());
};

export const keywordRuleIdFromPath = (request: Request): Option.Option<KeywordRuleId> =>
  pathId({ schema: KeywordRuleId, request });
