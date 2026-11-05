import { reviewPageSelection, reviewRelation } from "./review-page";
import { reviewAudit } from "./review-audit";
import {
  prepareChangedRowAssertion,
  prepareReservedChangeCheck,
} from "../../../src/shell/sql-assertions/operations";
import { Effect, Option, Schema } from "effect";
import {
  ReviewWorkspace,
  ReviewWorkspaceQuery,
  reviewPageSize,
} from "../../../src/core/ingestion/contract";
import {
  type QueryCaller,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { ReviewRow, projectReviewDetailFromSnapshot, projectReviewSummary } from "./review-store";
import { validationFailed } from "./statement-ingestion";
import type {
  CanonicalBrowserRead,
  PreparedCanonicalBrowserRead,
} from "../../canonical-admission/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { prepareCaptureCategories } from "../../categories/operations";

const Counts = Schema.Struct({ pendingCount: Schema.Int, total: Schema.Int });

const presentWorkspace = ({
  results,
  current,
  categories,
}: Readonly<{
  results: ReadonlyArray<D1Result>;
  current: number;
  categories: ReturnType<typeof prepareCaptureCategories>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const counts = yield* Schema.decodeUnknownEffect(Counts)(results[0]?.results[0]);
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ReviewRow))(results[1]?.results);
    const items = yield* Effect.forEach(rows, (row) => projectReviewSummary({ row, current }));
    const details = yield* Effect.forEach(rows.slice(0, 1), (row) =>
      projectReviewDetailFromSnapshot({
        row,
        current,
        categorize: categories.decode(results[2]?.results),
      })
    );
    const data = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(ReviewWorkspace))({
      ...counts,
      items,
      selectedDetail: Option.fromUndefinedOr(details[0]),
    });
    return Response.json({ data, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const prepareWorkspace = ({
  db,
  users,
  request,
  current,
}: Readonly<{
  db: D1Database;
  users: OwnedStatement;
  request: Request;
  current: number;
}>): PreparedCanonicalBrowserRead => {
  const query = Schema.decodeOption(Schema.toCodecStringTree(ReviewWorkspaceQuery))(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (Option.isNone(query)) {
    return {
      statements: [],
      present: () => Effect.succeed(validationFailed("Invalid review selection.")),
    };
  }
  const pending = Option.getOrElse(query.value.status, () => "pending") === "pending";
  const { filter, params } = reviewPageSelection({ query: query.value, current });
  const categories = prepareCaptureCategories({ db, users });
  const relation = reviewRelation.replace(
    "user_id = ?",
    `user_id IN (SELECT userId FROM (${users.sql}))`
  );
  const relationParams = [current, ...users.params];
  return {
    statements: [
      db
        .prepare(
          pending
            ? `SELECT count(*) AS pendingCount, count(*) AS total FROM (${relation}) WHERE ${filter}`
            : `SELECT count(CASE WHEN visible_status = 'pending' THEN 1 END) AS pendingCount,
        count(CASE WHEN ${filter} THEN 1 END) AS total FROM (${relation})`
        )
        .bind(...(pending ? [...relationParams, ...params] : [...params, ...relationParams])),
      db
        .prepare(`SELECT id, source, reason, time_zone AS timeZone, visible_status AS status, created_at_ms AS createdAt,
        expires_at_ms AS expiresAt, transaction_id AS transactionId, revision, draft_json, suggestions_json FROM (${relation}) WHERE ${filter}
        ORDER BY expires_at_ms, id LIMIT ? OFFSET ?`)
        .bind(
          ...relationParams,
          ...params,
          query.value.limit ?? reviewPageSize,
          Option.getOrElse(query.value.offset, () => 0)
        ),
      ...(query.value.limit === 0 ? [] : [categories.statement]),
    ],
    present: (results) => presentWorkspace({ results, current, categories }),
  };
};

/** Compose the bounded inbox and interpretation with exact browser admission. */
export const prepareBoundReviewWorkspace =
  (request: Request): CanonicalBrowserRead =>
  ({ db, authority, reservation, current }) => {
    const prepared = prepareWorkspace({ db, users: reservation, request, current });
    return {
      statements: [
        ...prepared.statements,
        prepareAuthorizedAuditCall({
          db,
          authority,
          id: transactionId(),
          current,
          operation: "ingestion.getReviewWorkspace",
          outcome: prepared.statements.length === 0 ? "rejected" : "accepted",
          afterOwnerWrite: false,
        }),
        prepareReservedChangeCheck({ db, scope: "ingestion_review", reservation }),
      ],
      present: prepared.present,
    };
  };

/** Original material never enters metadata queries or immutable agent transcripts. */
export const browseReviewWorkspace = ({
  db,
  subject,
  request,
}: Readonly<{ db: D1Database; subject: QueryCaller; request: Request }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const prepared = prepareWorkspace({
      db,
      users: { sql: "SELECT ? AS userId", params: [subject.userId] },
      request,
      current,
    });
    if (prepared.statements.length === 0) return yield* prepared.present([]);
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        ...prepared.statements,
        ...reviewAudit({
          work: { db, subject, current },
          operation: "ingestion.getReviewWorkspace",
          accepted: true,
        }),
        prepareChangedRowAssertion({ db, scope: "ingestion_review" }),
      ])
    );
    return yield* prepared.present(results);
  }).pipe(Effect.orElseSucceed(transactionUnavailable));
