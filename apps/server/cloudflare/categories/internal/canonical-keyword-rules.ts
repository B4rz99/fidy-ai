import { KeywordRuleId } from "../../../src/core/categories/contract";
import { NotFound } from "../../../src/shell/public-http/contract";
import { type Option, Schema } from "effect";
import { pathId } from "../../http/operations";
import { HTTP_NOT_FOUND, keywordRuleJsonHeaders } from "./keyword-rule-shared";

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

export const keywordRuleIdFromPath = (request: Request): Option.Option<KeywordRuleId> =>
  pathId({ schema: KeywordRuleId, request });
