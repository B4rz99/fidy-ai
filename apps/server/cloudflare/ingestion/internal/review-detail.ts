import type { CanonicalBrowserRead } from "../../canonical-admission/contract";
import { prepareCaptureCategories } from "../../categories/operations";
import { prepareAuditQueryCall } from "../../../src/shell/audit/operations";
import { prepareReservedChangeCheck } from "../../../src/shell/sql-assertions/operations";
import {
  type QueryCaller,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import {
  ReviewRow,
  projectReviewDetailFromSnapshot,
  readReviewDetail,
  reviewProjection,
} from "./review-store";
import { Effect, Option, Schema } from "effect";
import { ReviewDetail } from "../../../src/core/ingestion/contract";

import { commitReviewRead } from "./review-audit";

export const browseReviewItem = ({
  db,
  subject,
  request,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  request: Request;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const found = yield* readReviewDetail({ db, userId: subject.userId, id, current });
    yield* commitReviewRead({
      work: { db, subject, current },
      operation: "ingestion.getReviewItem",
      accepted: Option.isSome(found),
    });
    if (Option.isNone(found)) {
      return transactionFailure({
        code: "not_found",
        status: 404,
        message: "Elemento no disponible.",
      });
    }
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(ReviewDetail))(found.value);
    return Response.json({ data, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

/** Detail and its request-local Category interpretation join the complete browser snapshot. */
export const prepareBoundReviewItem =
  (request: Request): CanonicalBrowserRead =>
  ({ db, authority, reservation: users, current }) => {
    const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const owned = {
      sql: `SELECT 1 FROM ingestion_review_sources WHERE user_id IN (SELECT userId FROM (${users.sql})) AND id=?`,
      params: [...users.params, id],
    };
    const categories = prepareCaptureCategories({ db, users });
    return {
      statements: [
        db
          .prepare(
            `SELECT ${reviewProjection} FROM ingestion_review_sources WHERE user_id IN (SELECT userId FROM (${users.sql})) AND id=?`
          )
          .bind(current, ...users.params, id),
        categories.statement,
        prepareAuditQueryCall({
          db,
          authority,
          id: transactionId(),
          current,
          operation: "ingestion.getReviewItem",
          missingWhen: { sql: `SELECT 1 WHERE NOT EXISTS (${owned.sql})`, params: owned.params },
        }),
        prepareReservedChangeCheck({ db, scope: "ingestion_review", reservation: users }),
      ],
      present: (rows) =>
        Effect.gen(function* () {
          if (rows[0]?.results.length === 0) {
            return transactionFailure({
              code: "not_found",
              status: 404,
              message: "Elemento no disponible.",
            });
          }
          const row = yield* Schema.decodeUnknownEffect(ReviewRow)(rows[0]?.results[0]);
          const detail = yield* projectReviewDetailFromSnapshot({
            row,
            current,
            categorize: categories.decode(rows[1]?.results),
          });
          const data = yield* Schema.encodeEffect(Schema.toCodecJson(ReviewDetail))(detail);
          return Response.json({ data, next: [] }, { headers: transactionNoStore });
        }).pipe(Effect.orElseSucceed(transactionUnavailable)),
    };
  };
