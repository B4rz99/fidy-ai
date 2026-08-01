import { Effect, Match, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type UserId } from "~/core/identity/reference";
import { makeDashboardCatalog, makeDefaultDashboard } from "~/core/dashboard/catalog";
import {
  collectDashboardCategoryReferences,
  type DashboardCategoryReference,
  type DashboardDocument,
  type DashboardEdit,
} from "~/core/dashboard/model";
import { applyDashboardEdit } from "~/core/dashboard/rules";
import { resolveCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { categoryIds } from "~/core/categories/taxonomy";
import { findCategory } from "~/shell/categories/repo";
import { DashboardCategoryNotFound, toApiFailure } from "./errors";
import {
  findDashboard,
  generateDashboardWidgetId,
  insertDashboard,
  lockDashboard,
  updateDashboard,
} from "./repo";

const dashboardCatalog = makeDashboardCatalog({
  restaurantCategoryId: categoryIds.restaurantes,
});

const loadOrCreateDashboard = (userId: UserId) =>
  Effect.gen(function* () {
    const found = yield* findDashboard(userId);
    if (Option.isSome(found)) {
      return found.value;
    }
    const widgetId = yield* generateDashboardWidgetId;
    return yield* insertDashboard(userId, makeDefaultDashboard({ widgetId }));
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

const validateCategoryReferences = (document: DashboardDocument, edit: Readonly<DashboardEdit>) =>
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

const getDashboard = (userId: UserId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* lockDashboard(userId);
        return yield* loadOrCreateDashboard(userId);
      })
    )
  ).pipe(Effect.catchTag("SqlError", Effect.die));

const applyEdit = (input: { readonly userId: UserId; readonly edit: DashboardEdit }) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* lockDashboard(input.userId);
        const current = yield* loadOrCreateDashboard(input.userId);
        const candidate = yield* applyDashboardEdit({ document: current, edit: input.edit });
        yield* validateCategoryReferences(candidate, input.edit);
        return yield* updateDashboard(input.userId, candidate);
      })
    )
  ).pipe(Effect.catchTag("SqlError", Effect.die), Effect.mapError(toApiFailure));

/** Resolves User ownership before every dashboard read or atomic edit. */
export const DashboardLive = HttpApiBuilder.group(FidyApi, "dashboard", (handlers) =>
  handlers
    .handle("getDashboard", ({ request }) =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* resolveCaller(request);
        const document = yield* getDashboard(userId);
        return { data: document, next: [] };
      })
    )
    .handle("listDashboardCatalog", ({ request }) =>
      Effect.gen(function* () {
        yield* resolveCaller(request);
        return { data: dashboardCatalog, next: [] };
      })
    )
    .handle("applyDashboardEdit", ({ payload: edit, request }) =>
      Effect.gen(function* () {
        const { subjectUserId: userId } = yield* resolveCaller(request);
        const document = yield* applyEdit({ userId, edit });
        return { data: document, next: [] };
      })
    )
);
