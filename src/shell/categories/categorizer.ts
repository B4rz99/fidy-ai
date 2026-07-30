import { Effect, Option } from "effect";
import { type CategoryId } from "~/core/_shared/category";
import { type UserId } from "~/core/_shared/user";
import { findKnownCaptureCategory, findKeywordCategory } from "~/core/categories/rules";
import { categoryIds } from "~/core/categories/taxonomy";
import { listKeywordRules } from "./repo";

/** Stand-in for the future model adapter; absence there resolves explicitly to Otros. */
const modelFallback = (): Effect.Effect<CategoryId> => Effect.succeed(categoryIds.otros);

/**
 * Applies explicit and User-rule choices before consulting the model fallback.
 * The returned Category is always present.
 */
export const categorizeCapture = ({
  userId,
  merchant,
  callerCategory,
}: {
  readonly userId: UserId;
  readonly merchant: string;
  readonly callerCategory: Option.Option<CategoryId>;
}) =>
  Effect.gen(function* () {
    const rules = yield* listKeywordRules(userId);
    const keywordCategory = yield* findKeywordCategory({ merchant, rules });
    const known = yield* findKnownCaptureCategory({
      caller: callerCategory,
      keywordRule: keywordCategory,
    });

    return Option.isSome(known) ? known.value : yield* modelFallback();
  });
