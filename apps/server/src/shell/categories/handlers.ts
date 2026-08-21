import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { resolveFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { createKeywordRule, deleteKeywordRule, updateKeywordRule } from "./mutations";
import { listCategories, listKeywordRules } from "./queries";

/** Provides public Categories and bounded, deterministic User keyword-rule management. */
export const CategoriesLive = HttpApiBuilder.group(FidyApi, "categories", (handlers) =>
  handlers
    .handle("listCategories", () =>
      Effect.gen(function* () {
        yield* ResolvedCaller;
        return yield* listCategories();
      })
    )
    .handle("listKeywordRules", () =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return yield* listKeywordRules({ userId: subjectUserId });
      })
    )
    .handle("createKeywordRule", ({ payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* createKeywordRule({ userId, caller, payload });
      })
    )
    .handle("updateKeywordRule", ({ params, payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* updateKeywordRule({ userId, caller, keywordRuleId: params.id, payload });
      })
    )
    .handle("deleteKeywordRule", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* deleteKeywordRule({ userId, caller, keywordRuleId: params.id });
      })
    )
);
