import { Data, Effect, Option, Schema } from "effect";
import {
  ReviewWorkspace,
  ReviewWorkspaceQuery,
  reviewPageSize,
} from "../../../src/core/ingestion/contract";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { recordLivePATUse } from "../../../src/shell/tokens/operations";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { ReviewRow, projectReviewSummary } from "./review-store";
import { validationFailed } from "./statement-ingestion";

const Counts = Schema.Struct({ pendingCount: Schema.Int, total: Schema.Int });
const relation = `SELECT *, CASE WHEN status != 'created' AND expires_at_ms <= ?
  THEN 'expired' ELSE status END AS visible_status FROM ingestion_review_sources WHERE user_id = ?`;
const completion = `INSERT INTO ingestion_review_assertion (id, accepted)
  VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
  ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

class ReviewWorkspaceUnavailable extends Data.TaggedError("ReviewWorkspaceUnavailable") {}

const readAccountability = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  current: number;
}>): ReadonlyArray<D1PreparedStatement> => {
  const use = isPATCaller(subject)
    ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
        db.prepare(sql).bind(...params)
      )
    : [];
  return [
    ...use,
    prepareAuthorizedAuditCall({
      db,
      authority: callerAuthority({ subject, current }),
      id: transactionId(),
      current,
      operation: "ingestion.getReviewWorkspace",
      outcome: "accepted",
      afterOwnerWrite: false,
    }),
  ];
};

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
    const status = Option.getOrElse(query.value.status, () => "pending");
    const filter =
      status === "pending"
        ? "visible_status = 'pending'"
        : "visible_status != 'pending' AND (? = 'history' OR visible_status = ?)";
    const params = status === "pending" ? [] : [status, status];
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(`SELECT count(CASE WHEN visible_status = 'pending' THEN 1 END) AS pendingCount,
      count(CASE WHEN ${filter} THEN 1 END) AS total FROM (${relation})`)
          .bind(...params, current, subject.userId),
        db
          .prepare(`SELECT id, source, reason, time_zone AS timeZone, visible_status AS status, created_at_ms AS createdAt,
      expires_at_ms AS expiresAt, transaction_id AS transactionId, revision, draft_json, suggestions_json FROM (${relation}) WHERE ${filter}
      ORDER BY expires_at_ms, id LIMIT ? OFFSET ?`)
          .bind(
            current,
            subject.userId,
            ...params,
            reviewPageSize,
            Option.getOrElse(query.value.offset, () => 0)
          ),
        ...readAccountability({ db, subject, current }),
        db.prepare(completion),
      ])
    );
    const counts = yield* Schema.decodeUnknownEffect(Counts)(results[0]?.results[0]);
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ReviewRow))(results[1]?.results);
    const items = yield* Effect.forEach(rows, (row) => projectReviewSummary({ row, current }));
    const data = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(ReviewWorkspace))({
      ...counts,
      items,
    });
    return Response.json({ data, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.mapError(() => new ReviewWorkspaceUnavailable()));

/** Original material never enters metadata queries or immutable agent transcripts. */
export const browseReviewWorkspace = (
  input: Parameters<typeof readWorkspace>[0]
): Effect.Effect<Response> =>
  readWorkspace(input).pipe(Effect.orElseSucceed(transactionUnavailable));
