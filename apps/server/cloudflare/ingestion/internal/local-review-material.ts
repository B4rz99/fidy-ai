import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { localPreparationSubject, runLocalMutation } from "../../canonical-admission/operations";
import { userPrivateObjectPrefix } from "../../private-objects/operations";
import { MaterialRow, materialText, unavailable } from "./review-material";
import { missing, result } from "./local-review-snapshot";

const materialIdPosition = -2;

const cap = 100_000;

const sameRevision = (
  left: typeof MaterialRow.Type & { revision: number; expires: number },
  right: typeof MaterialRow.Type & { revision: number; expires: number }
): boolean =>
  left.revision === right.revision &&
  left.expires === right.expires &&
  Option.getOrNull(left.object_key) === Option.getOrNull(right.object_key);

const selected = Effect.fn(function* (user: UserId, id: string) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT r.evidence_expires_at_ms AS expires,coalesce(r.workspace_revision,0) AS revision,
    CASE WHEN r.source_kind='statement' THEN r.original_evidence WHEN r.source_kind='media' THEN m.caption END AS text,
    CASE WHEN e.state='queued' AND substr(e.object_key,1,length(${userPrivateObjectPrefix(user) + "email/"}))=${userPrivateObjectPrefix(user) + "email/"} THEN e.object_key END AS object_key FROM ingestion_review_items r
    LEFT JOIN forwarded_email_receipts e ON e.user_id=r.user_id AND e.id=r.email_receipt_id
    LEFT JOIN media_submissions m ON m.user_id=r.user_id AND m.id=r.media_submission_id
    WHERE r.user_id=${user} AND r.id=${id}`;

  return row === undefined
    ? Option.none()
    : Option.some(
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({ ...MaterialRow.fields, expires: Schema.Int, revision: Schema.Int })
        )(row)
      );
});

export const localReviewMaterial = Effect.fn(function* (unit: {
  request: Request;
  storage: DurableObjectStorage;
  operation: CatalogOperation;
  owns: (id: string) => boolean;
  bucket: R2Bucket;
}) {
  const id = new URL(unit.request.url).pathname.split("/").at(materialIdPosition) ?? "";
  const subject = yield* localPreparationSubject(unit.request, unit.owns, unit.operation);
  const before = Option.isSome(subject) ? yield* selected(subject.value, id) : Option.none();
  const now = yield* Clock.currentTimeMillis;

  const text =
    Option.isSome(before) && before.value.expires > now
      ? yield* materialText({ row: before.value, bucket: Option.fromNullishOr(unit.bucket) })
      : Option.none();

  return yield* runLocalMutation({
    ...unit,
    input: Effect.succeedSome(id),
    work: (target, user, current) =>
      Effect.gen(function* () {
        const after = yield* selected(user, target);

        if (
          Option.isNone(after) ||
          Option.isNone(before) ||
          Option.isNone(subject) ||
          subject.value !== user
        ) {
          return missing();
        }

        if (after.value.expires <= current) return result({ available: false, reason: "expired" });

        if (!sameRevision(after.value, before.value)) {
          return result(unavailable);
        }

        return result(
          Option.isSome(text)
            ? {
                available: true,
                text: text.value.slice(0, cap),
                truncated: text.value.length > cap,
              }
            : unavailable
        );
      }),
  });
});
