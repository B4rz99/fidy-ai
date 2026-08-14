import { Effect, Match, Option, type Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import {
  type DashboardCategoryReference,
  type DashboardDocument,
  type DashboardEdit,
  collectDashboardCategoryReferences,
} from "~/core/dashboard/model";
import { makeDefaultDashboard } from "~/core/dashboard/catalog";
import { applyDashboardEdit as decideDashboardEdit } from "~/core/dashboard/rules";
import { type UserId } from "~/core/identity/reference";
import { type CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import { type OperationResponse } from "~/shell/_shared/response";
import { type SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { findCategory } from "~/shell/categories/repo";
import { type DashboardApiFailure, DashboardCategoryNotFound, toApiFailure } from "./errors";
import {
  findDashboardInScope,
  generateDashboardWidgetId,
  insertDashboardInScope,
  updateDashboardInScope,
  withDashboardLockInScope,
} from "./repo";

type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

/**
 * Returns the latest DashboardDocument or creates its first-use default. The caller must hold the
 * User's Dashboard advisory lock in the matching User-scoped transaction so concurrent first use
 * is serialized with later edits.
 */
export const loadOrCreateDashboard = (
  userId: UserId
): Effect.Effect<DashboardDocument, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const found = yield* findDashboardInScope(userId);
    if (Option.isSome(found)) return found.value;
    const widgetId = yield* generateDashboardWidgetId;
    return yield* insertDashboardInScope(userId, makeDefaultDashboard({ widgetId }));
  });

const resolveCategoryReferencePath = (
  reference: Readonly<DashboardCategoryReference>,
  edit: Readonly<DashboardEdit>
): string =>
  Match.value(edit).pipe(
    Match.when({ op: "add-widget" }, ({ widget }) => Option.some(widget.id)),
    Match.when({ op: "update-widget" }, ({ widget }) => Option.some(widget.id)),
    Match.orElse(() => Option.none()),
    Option.filter((widgetId) => widgetId === reference.widgetId),
    Option.match({
      onNone: () => `layout.${reference.widgetId}.${reference.field}`,
      onSome: () => `widget.${reference.field}`,
    })
  );

const validateCategoryReferences = (
  document: DashboardDocument,
  edit: Readonly<DashboardEdit>
): Effect.Effect<void, DashboardCategoryNotFound, SqlClient.SqlClient> =>
  Effect.forEach(
    collectDashboardCategoryReferences(document),
    (reference) =>
      findCategory(reference.categoryId).pipe(
        Effect.flatMap(
          Effect.fromOption(
            () =>
              new DashboardCategoryNotFound({
                categoryId: reference.categoryId,
                path: resolveCategoryReferencePath(reference, edit),
              })
          )
        )
      ),
    { discard: true }
  );

/** Facts supplied after canonical decoding and caller authorization for one Dashboard edit. */
export type DashboardEditMutationInput = Readonly<{
  userId: UserId;
  edit: DashboardEdit;
  caller: SuggestedOperationCaller;
}>;

/**
 * Applies one all-or-nothing Dashboard edit in the caller's active User-scoped transaction. The
 * caller owns commit or rollback; locking, default creation, document rules, and Category
 * validation all participate in that same transaction.
 */
export const applyDashboardEdit: CanonicalMutationImplementation<
  DashboardEditMutationInput,
  MutationResponse<typeof DashboardDocument>,
  DashboardApiFailure
> = Effect.fn("applyDashboardEdit")(function* ({ userId, edit, caller }) {
  const document = yield* withDashboardLockInScope(
    userId,
    Effect.gen(function* () {
      const current = yield* loadOrCreateDashboard(userId);
      const candidate = yield* decideDashboardEdit({ document: current, edit });
      yield* validateCategoryReferences(candidate, edit);
      return yield* updateDashboardInScope(userId, candidate);
    })
  ).pipe(Effect.mapError((failure) => toApiFailure({ failure, caller })));
  return { data: document, next: [] };
});
