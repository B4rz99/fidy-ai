import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { hostedStatementSelection } from "./local-statement-scope";
import { localDetail, missing, readDetail, result } from "./local-review-snapshot";
import { localReviewMaterial } from "./local-review-material";
import { localReviewPage, localSubmission } from "./local-review-list";
import { reviewPage } from "./statement-review";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { type UserId } from "../../../src/core/identity/contract";
import {
  ReviewDetail,
  ReviewWorkspace,
  ReviewWorkspaceQuery,
  StatementSubmissionId,
  reviewPageSize,
} from "../../../src/core/ingestion/contract";
import {
  canonicalAdmissionUnavailable,
  runLocalMutation,
} from "../../canonical-admission/operations";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { ReviewRow, projectReviewSummary } from "./review-store";
import { reviewPageSelection, reviewRelation } from "./review-page";
import { ContextRow, contextSql, maximumExcerptCells, projectContext } from "./review-page-context";
import {
  ReviewPageContext,
  maximumReviewExcerptCharacters,
} from "../../../src/shell/ingestion/contract";

export const isLocalReviewOperation = Schema.is(
  Schema.Literals([
    "ingestion.getReviewWorkspace",
    "ingestion.getReviewPageContext",
    "ingestion.getReviewItem",
    "ingestion.listNeedsReviewItems",
    "ingestion.getStatementSubmission",
    "ingestion.getReviewMaterial",
  ])
);

const originFilter = (
  turn: Option.Option<string>,
  user: UserId,
  current: number
): OwnedStatement => {
  if (Option.isNone(turn)) return { sql: "", params: [] };
  const source = hostedStatementSelection({ turn: turn.value, user, current });

  return {
    sql:
      " AND id IN (SELECT id FROM ingestion_review_items WHERE user_id=? AND statement_submission_id IN (" +
      source.sql +
      "))",
    params: [user, ...source.params],
  };
};

const readContext = Effect.fn(function* ({
  page,
  filter,
  current,
  offset,
}: {
  page: OwnedStatement["params"];
  filter: string;
  current: number;
  offset: number;
}) {
  const sql = yield* SqliteClient;

  const raw = yield* sql.unsafe(contextSql(filter), [
    ...page,
    current,
    current,
    maximumReviewExcerptCharacters,
    maximumExcerptCells,
    maximumReviewExcerptCharacters,
  ]);

  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ContextRow))(raw);
  const items = rows.map((row, index) => projectContext({ row, position: offset + index + 1 }));

  return result(
    yield* Schema.encodeEffect(Schema.toCodecJson(ReviewPageContext))(
      yield* Schema.decodeEffect(Schema.toCodecJson(ReviewPageContext))({ items })
    )
  );
});

export const workspace = Effect.fn(function* (
  query: typeof ReviewWorkspaceQuery.Type,
  user: UserId,
  {
    current,
    context,
    hostedTurn,
  }: { current: number; context: boolean; hostedTurn: Option.Option<string> }
) {
  const sql = yield* SqliteClient;
  const { filter, params } = reviewPageSelection({ query, current });
  const offset = Option.getOrElse(query.offset, () => 0);
  const origin = originFilter(hostedTurn, user, current);
  const relation = reviewRelation + origin.sql;
  const page = [current, user, ...origin.params, ...params, query.limit ?? reviewPageSize, offset];

  if (context) return yield* readContext({ page, filter, current, offset });
  const pending = Option.getOrElse(query.status, () => "pending") === "pending";

  const [counts] = pending
    ? yield* sql.unsafe(
        `SELECT count(*) AS pendingCount,count(*) AS total FROM (${relation}) WHERE ${filter}`,
        [current, user, ...origin.params, ...params]
      )
    : yield* sql.unsafe(
        `SELECT count(CASE WHEN visible_status='pending' THEN 1 END) AS pendingCount,count(CASE WHEN ${filter} THEN 1 END) AS total FROM (${relation})`,
        [...params, current, user, ...origin.params]
      );

  const raw = yield* sql.unsafe(
    `SELECT id,source,reason,time_zone AS timeZone,visible_status AS status,created_at_ms AS createdAt,
    expires_at_ms AS expiresAt,transaction_id AS transactionId,revision,draft_json,suggestions_json FROM (${relation}) WHERE ${filter}
    ORDER BY expires_at_ms,id LIMIT ? OFFSET ?`,
    page
  );

  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ReviewRow))(raw);
  const items = yield* Effect.forEach(rows, (row) => projectReviewSummary({ row, current }));

  const selectedDetail = yield* Effect.transposeOption(
    Option.map(Option.fromUndefinedOr(rows[0]), (row) => localDetail({ row, user, current }))
  );

  const totals = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ pendingCount: Schema.Int, total: Schema.Int })
  )(counts);

  return result(
    yield* Schema.encodeEffect(Schema.toCodecJson(ReviewWorkspace))({
      ...totals,
      items,
      selectedDetail,
    })
  );
});

export const dispatchLocalReview = Effect.fn(
  function* (unit: {
    request: Request;
    storage: DurableObjectStorage;
    bucket: R2Bucket;
    owns: (id: string) => boolean;
    operation: CatalogOperation;
  }) {
    if (unit.operation.id === "ingestion.getReviewMaterial") {
      return yield* localReviewMaterial(unit);
    }

    if (unit.operation.id === "ingestion.listNeedsReviewItems") {
      return yield* runLocalMutation({
        ...unit,
        input: Effect.succeed(reviewPage(new URL(unit.request.url))),
        work: localReviewPage,
      });
    }

    if (unit.operation.id === "ingestion.getStatementSubmission") {
      const id = new URL(unit.request.url).pathname.split("/").at(-1) ?? "";

      const invalid = Option.isNone(Schema.decodeOption(StatementSubmissionId)(id))
        ? Option.some(missing())
        : Option.none();

      return yield* runLocalMutation(
        {
          ...unit,
          input: Effect.succeedSome(id),
          work: (target, user) => localSubmission(user, target),
        },
        invalid
      );
    }

    if (unit.operation.id === "ingestion.getReviewItem") {
      const id = new URL(unit.request.url).pathname.split("/").at(-1) ?? "";

      return yield* runLocalMutation({
        ...unit,
        input: Effect.succeedSome(id),
        work: (target, user, current) =>
          readReviewItem(user, target, { current, hostedTurn: Option.none() }),
      });
    }

    const query = Schema.decodeOption(Schema.toCodecStringTree(ReviewWorkspaceQuery))(
      Object.fromEntries(new URL(unit.request.url).searchParams)
    );

    return yield* runLocalMutation({
      ...unit,
      input: Effect.succeed(query),
      work: (selection, user, current) =>
        workspace(selection, user, {
          current,
          context: unit.operation.id === "ingestion.getReviewPageContext",
          hostedTurn: Option.none(),
        }),
    });
  },
  Effect.tapCause(() =>
    Effect.logWarning({ component: "ingestion", operation: "localReview", outcome: "unavailable" })
  ),
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const readReviewItem = Effect.fn(function* (
  user: UserId,
  target: string,
  { current, hostedTurn }: { current: number; hostedTurn: Option.Option<string> }
) {
  const origin = originFilter(hostedTurn, user, current);
  const detail = yield* readDetail(user, target, { current, origin });

  return Option.isNone(detail)
    ? yield* missing()
    : result(yield* Schema.encodeEffect(Schema.toCodecJson(ReviewDetail))(detail.value));
});
