import { Effect, Option, Schema } from "effect";
import { operationCatalog } from "../../../src/shell/api";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import type { CanonicalMutationRefusal, PreparedCanonicalMutation } from "../contract";
import type {
  OAuthConfirmationWork,
  OAuthNativeReview,
  OAuthReviewBinding,
} from "../../oauth-confirmation/contract";
import { prepareOAuthConfirmation } from "../../oauth-confirmation/operations";
import { oauthConfirmationRefusal, requiresOAuthConfirmation } from "./oauth-confirmation";

const declaration = (mutation: PreparedCanonicalMutation): Option.Option<CatalogOperation> =>
  Option.fromUndefinedOr(
    operationCatalog.operations.find(({ id }) => id === mutation.outcome.operation)
  );
const sensitive = (mutation: PreparedCanonicalMutation): boolean =>
  declaration(mutation).pipe(
    Option.map(requiresOAuthConfirmation),
    Option.getOrElse(() => false)
  );
const reviewBinding = (mutations: ReadonlyArray<PreparedCanonicalMutation>): OAuthReviewBinding =>
  mutations.map((mutation) => ({
    operation: Schema.decodeSync(CanonicalOperationId)(mutation.outcome.operation),
    scope: Option.getOrNull(mutation.requiredScope),
    effect: Option.map(mutation.oauthReview, ({ effect }) => effect).pipe(
      Option.getOrElse(() => "")
    ),
    revision: Option.map(mutation.oauthReview, ({ revision }) => revision).pipe(
      Option.getOrElse(() => "")
    ),
  }));
type UnitReview =
  | Readonly<{ _tag: "Continue"; statements: ReadonlyArray<D1PreparedStatement> }>
  | Readonly<{ _tag: "ConfirmationReview"; review: OAuthNativeReview }>
  | Readonly<{ _tag: "Refused"; index: number; refusal: CanonicalMutationRefusal }>
  | Readonly<{ _tag: "Unavailable" }>;
type Work = Readonly<{
  db: D1Database;
  subject: OAuthCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  oauthConfirmation: Option.Option<OAuthConfirmationWork>;
}>;
const prepareSensitiveUnit = (
  work: Work,
  index: number,
  operation: CatalogOperation
): Effect.Effect<UnitReview> =>
  Effect.gen(function* () {
    const refused: UnitReview = {
      _tag: "Refused",
      index,
      refusal: oauthConfirmationRefusal({
        db: work.db,
        subject: work.subject,
        current: work.current,
        operation,
      }),
    };
    if (
      Option.isNone(work.oauthConfirmation) ||
      work.mutations.some((mutation) => sensitive(mutation) && Option.isNone(mutation.oauthReview))
    ) {
      return refused;
    }
    const prepared = yield* prepareOAuthConfirmation({
      db: work.db,
      subject: work.subject,
      work: work.oauthConfirmation.value,
      binding: reviewBinding(work.mutations),
    });
    if (prepared._tag === "Refused") return refused;
    if (prepared._tag === "Review") return { _tag: "ConfirmationReview", review: prepared.review };
    return {
      _tag: "Continue",
      statements: [
        ...prepared.statements,
        ...work.mutations.flatMap((mutation) =>
          Option.map(mutation.oauthReview, ({ guards }) => guards).pipe(Option.getOrElse(() => []))
        ),
      ],
    };
  });
/** Both sensitive and ordinary children bind the complete original invocation and ordered scopes. */
export const prepareOAuthUnitConfirmation = (work: Work): Effect.Effect<UnitReview> => {
  const index = work.mutations.findIndex(sensitive);
  if (index < 0) {
    return Effect.succeed(
      Option.isSome(work.oauthConfirmation) &&
        work.oauthConfirmation.value.attempt._tag === "Decision"
        ? { _tag: "Unavailable" }
        : { _tag: "Continue", statements: [] }
    );
  }
  const mutation = work.mutations[index];
  const operation =
    mutation === undefined ? Option.none<CatalogOperation>() : declaration(mutation);
  return Option.match(operation, {
    onNone: () => Effect.succeed({ _tag: "Unavailable" } as const),
    onSome: (operation) => prepareSensitiveUnit(work, index, operation),
  });
};
