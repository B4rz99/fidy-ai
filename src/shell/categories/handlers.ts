import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { makeFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { createKeywordRule, deleteKeywordRule, updateKeywordRule } from "./mutations";
import { listCategories, listKeywordRules } from "./repo";

/** Provides public Categories and bounded, deterministic User keyword-rule management. */
export const CategoriesLive = HttpApiBuilder.group(FidyApi, "categories", (handlers) =>
  handlers
    .handle("listCategories", () =>
      Effect.gen(function* () {
        yield* ResolvedCaller;
        return { data: yield* listCategories, next: [] };
      })
    )
    .handle("listKeywordRules", () =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return { data: yield* listKeywordRules(subjectUserId), next: [] };
      })
    )
    .handle("createKeywordRule", ({ payload }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        return yield* createKeywordRule({
          userId: subjectUserId,
          caller: makeFreeSuggestedOperationCaller(scopes),
          payload,
        });
      })
    )
    .handle("updateKeywordRule", ({ params, payload }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        return yield* updateKeywordRule({
          userId: subjectUserId,
          caller: makeFreeSuggestedOperationCaller(scopes),
          keywordRuleId: params.id,
          payload,
        });
      })
    )
    .handle("deleteKeywordRule", ({ params }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        return yield* deleteKeywordRule({
          userId: subjectUserId,
          caller: makeFreeSuggestedOperationCaller(scopes),
          keywordRuleId: params.id,
        });
      })
    )
);
