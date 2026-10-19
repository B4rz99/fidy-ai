import { Effect, Option, Schema } from "effect";
import { ReviewDetail } from "../../../src/core/ingestion/contract";
import {
  type QueryCaller,
  transactionFailure,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { reviewAudit } from "./review-audit";
import { readReviewDetail, reviewCompletion } from "./review-store";

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
    yield* Effect.tryPromise(() =>
      db.batch([
        ...reviewAudit({
          work: { db, subject, current },
          operation: "ingestion.getReviewItem",
          accepted: Option.isSome(found),
        }),
        db.prepare(reviewCompletion),
      ])
    );
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
