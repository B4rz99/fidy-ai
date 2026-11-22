import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import {
  type CanonicalRejection,
  type LocalMutationResult,
  notFoundRejection,
} from "../../canonical-admission/contract";
import { resolveLocalCategory } from "../../categories/operations";
import { ReviewRow, projectReviewDetailFromSnapshot, reviewProjection } from "./review-store";

export const result = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

export const localDetail = Effect.fnUntraced(function* ({
  row,
  user,
  current,
}: {
  row: typeof ReviewRow.Type;
  user: UserId;
  current: number;
}) {
  return yield* projectReviewDetailFromSnapshot({
    row,
    current,
    categorize: (captures) =>
      Effect.forEach(captures, (capture) =>
        resolveLocalCategory({ userId: user, capture }).pipe(
          Effect.map((category) => category.categoryId)
        )
      ),
  });
});

export const missing = (): CanonicalRejection => notFoundRejection("Elemento no disponible.");

export const readDetail = Effect.fn(function* (
  user: UserId,
  id: string,
  { current, origin }: { current: number; origin: OwnedStatement }
) {
  const sql = yield* SqliteClient;

  const [raw] = yield* sql.unsafe(
    `SELECT ${reviewProjection} FROM ingestion_review_sources WHERE user_id=? AND id=?` +
      origin.sql,
    [current, user, id, ...origin.params]
  );

  if (raw === undefined) return Option.none();

  return Option.some(
    yield* localDetail({ row: yield* Schema.decodeUnknownEffect(ReviewRow)(raw), user, current })
  );
});

export const readOwnedDetail = Effect.fnUntraced(function* (
  user: UserId,
  id: string,
  current: number
) {
  return yield* readDetail(user, id, { current, origin: { sql: "", params: [] } });
});
