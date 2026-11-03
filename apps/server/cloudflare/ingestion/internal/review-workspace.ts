import { reviewPageSelection, reviewRelation } from "./review-page";
import type { ReviewUnavailable } from "../contract";
import { reviewAudit } from "./review-audit";
import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { Data, Effect, Option, Schema } from "effect";
import {
  type ReviewDetail,
  ReviewWorkspace,
  ReviewWorkspaceQuery,
  reviewPageSize,
} from "../../../src/core/ingestion/contract";
import {
  type QueryCaller,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { ReviewRow, projectReviewDetail, projectReviewSummary } from "./review-store";
import { validationFailed } from "./statement-ingestion";

const Counts = Schema.Struct({ pendingCount: Schema.Int, total: Schema.Int });
const firstReviewDetail = ({
  db,
  userId,
  rows,
  current,
}: Readonly<{
  db: D1Database;
  userId: string;
  rows: ReadonlyArray<typeof ReviewRow.Type>;
  current: number;
}>): Effect.Effect<Option.Option<ReviewDetail>, ReviewUnavailable> =>
  Effect.forEach(rows.slice(0, 1), (row) => projectReviewDetail({ db, userId, row, current })).pipe(
    Effect.map((details) => Option.fromUndefinedOr(details[0]))
  );

class ReviewWorkspaceUnavailable extends Data.TaggedError("ReviewWorkspaceUnavailable") {}

const readWorkspace = ({
  db,
  subject,
  request,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  request: Request;
}>): Effect.Effect<Response, ReviewWorkspaceUnavailable> =>
  Effect.gen(function* () {
    const query = Schema.decodeOption(Schema.toCodecStringTree(ReviewWorkspaceQuery))(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    if (Option.isNone(query)) return validationFailed("Invalid review selection.");
    const current = transactionNow();
    const { filter, params } = reviewPageSelection(query.value);
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(`SELECT count(CASE WHEN visible_status = 'pending' THEN 1 END) AS pendingCount,
      count(CASE WHEN ${filter} THEN 1 END) AS total FROM (${reviewRelation})`)
          .bind(...params, current, subject.userId),
        db
          .prepare(`SELECT id, source, reason, time_zone AS timeZone, visible_status AS status, created_at_ms AS createdAt,
      expires_at_ms AS expiresAt, transaction_id AS transactionId, revision, draft_json, suggestions_json FROM (${reviewRelation}) WHERE ${filter}
      ORDER BY expires_at_ms, id LIMIT ? OFFSET ?`)
          .bind(
            current,
            subject.userId,
            ...params,
            query.value.limit ?? reviewPageSize,
            Option.getOrElse(query.value.offset, () => 0)
          ),
        ...reviewAudit({
          work: { db, subject, current },
          operation: "ingestion.getReviewWorkspace",
          accepted: true,
        }),
        prepareChangedRowAssertion({ db, scope: "ingestion_review" }),
      ])
    );
    const counts = yield* Schema.decodeUnknownEffect(Counts)(results[0]?.results[0]);
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ReviewRow))(results[1]?.results);
    const items = yield* Effect.forEach(rows, (row) => projectReviewSummary({ row, current }));
    const data = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(ReviewWorkspace))({
      ...counts,
      items,
      selectedDetail: yield* firstReviewDetail({ db, userId: subject.userId, rows, current }),
    });
    return Response.json({ data, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.mapError(() => new ReviewWorkspaceUnavailable()));

/** Original material never enters metadata queries or immutable agent transcripts. */
export const browseReviewWorkspace = (
  input: Parameters<typeof readWorkspace>[0]
): Effect.Effect<Response> =>
  readWorkspace(input).pipe(Effect.orElseSucceed(transactionUnavailable));
