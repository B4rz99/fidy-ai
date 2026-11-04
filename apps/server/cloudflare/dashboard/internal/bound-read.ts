import { DateTime, Effect, Schema } from "effect";
import type { CanonicalBrowserRead } from "../../canonical-admission/contract";
import {
  prepareSelectedUserDocument,
  selectedUserDocumentProjection,
} from "../../user-documents/operations";
import { prepareSelectedUserContext } from "../../identity/user-context/operations";
import { prepareCategorySnapshot } from "../../categories/operations";
import { prepareSelectedDashboardLists } from "../../transactions/operations";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { prepareReservedChangeCheck } from "../../../src/shell/sql-assertions/operations";
import {
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { DashboardDocument } from "../../../src/core/dashboard/contract";
import { UserContext } from "../../../src/core/identity/contract";
import { collectLayoutWidgets } from "../../../src/core/dashboard/operations";
import { renderDashboardView } from "../../../src/shell/dashboard/operations";
import { DashboardUnavailable, DashboardView } from "../../../src/shell/dashboard/contract";

const DocumentRow = Schema.Struct({
  encoded: Schema.fromJsonString(Schema.toCodecJson(DashboardDocument)),
  revision: Schema.Int,
});

type Sources = Readonly<{
  current: number;
  categories: ReturnType<typeof prepareCategorySnapshot>;
  lists: ReturnType<typeof prepareSelectedDashboardLists>;
}>;

const uninitialized = (): Response =>
  Response.json(
    {
      error: {
        code: "dashboard_uninitialized",
        message: "Initialize your Dashboard explicitly, then read it again.",
      },
      next: [],
    },
    { status: 404, headers: transactionNoStore }
  );

const decodeView = (
  { current, categories, lists }: Sources,
  results: ReadonlyArray<D1Result>,
  retained: typeof DocumentRow.Type
): Effect.Effect<DashboardView, DashboardUnavailable> =>
  Effect.gen(function* () {
    const context = yield* Schema.decodeUnknownEffect(Schema.Tuple([UserContext]))(
      results[1]?.results
    );
    const taxonomy = yield* Effect.fromOption(categories.decode(results[2]?.results));
    const selected = yield* Effect.fromOption(lists.decode(results[3]?.results, taxonomy));
    const widgets = collectLayoutWidgets(retained.encoded.layout);
    if (
      widgets.some((widget) => widget.type !== "transaction-list") ||
      selected.size !== widgets.length
    ) {
      return yield* new DashboardUnavailable();
    }
    return yield* renderDashboardView({
      document: retained.encoded,
      now: DateTime.makeUnsafe(current),
      facts: {
        context: context[0],
        categories: new Map(taxonomy.map((category) => [category.id, category])),
        lists: selected,
        budgets: [],
        groups: new Map(),
      },
    });
  }).pipe(Effect.mapError(() => new DashboardUnavailable()));

const present = (sources: Sources, results: ReadonlyArray<D1Result>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (results[4]?.meta.changes !== 1) return transactionUnavailable();
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(DocumentRow).check(Schema.isMaxLength(1))
    )(results[0]?.results);
    const retained = rows[0];
    if (retained === undefined) return uninitialized();
    const view = yield* decodeView(sources, results, retained);
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(DashboardView))(view);
    return Response.json(
      { data, next: [] },
      { headers: { ...transactionNoStore, etag: `"${retained.revision}"` } }
    );
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

export const prepareBoundDashboardRead: CanonicalBrowserRead = ({
  db,
  authority,
  reservation,
  current,
}) => {
  const lists = prepareSelectedDashboardLists({
    db,
    demand: selectedUserDocumentProjection({
      userSelection: reservation,
      kind: "dashboard",
      statement: {
        sql: `SELECT userId, json_extract(node.value,'$.id') AS widgetId,
      json_extract(node.value,'$.categories') AS categories, json_extract(node.value,'$.search') AS search,
      json_extract(node.value,'$.limit') AS listLimit FROM selected_user_document, json_tree(encoded,'$.layout') node
      WHERE node.key='widget' AND json_extract(node.value,'$.type')='transaction-list'`,
        params: [],
      },
    }),
  });
  const categories = prepareCategorySnapshot({ db, authority });
  return {
    statements: [
      prepareSelectedUserDocument({ db, userSelection: reservation, kind: "dashboard" }),
      prepareSelectedUserContext({ db, userSelection: reservation }),
      categories.statement,
      lists.statement,
      prepareAuthorizedAuditCall({
        db,
        authority,
        id: transactionId(),
        current,
        operation: "dashboard.getDashboardView",
        outcome: "accepted",
        afterOwnerWrite: false,
      }),
      prepareReservedChangeCheck({ db, scope: "dashboard", reservation }),
    ],
    present: (results) => present({ current, categories, lists }, results),
  };
};
