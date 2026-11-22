import { localReviewEditConfirmation } from "./oauth-review";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Predicate, Schema } from "effect";
import { type ReviewCommand, ReviewEditResult } from "../../../src/core/ingestion/contract";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { prepareLocalWrite } from "../../canonical-admission/operations";
import {
  CanonicalAdmissionUnavailable,
  type LocalMutationResult,
} from "../../canonical-admission/contract";
import { prepareSourcedCapture } from "../../transactions/operations";
import { reviewDraftJson } from "./review-store";
import { readOwnedDetail, result } from "./local-review-snapshot";

export const invalid = (): LocalMutationResult => ({
  status: 400,
  outcome: "validation_failed",
  body: {
    error: {
      code: "validation_failed",
      message: "Actualiza la revisión antes de continuar.",
      fields: [],
    },
    next: [],
  },
});

const captureRefused = (
  capture: Option.Option<Effect.Success<ReturnType<typeof prepareSourcedCapture>>>
): boolean => Option.isSome(capture) && !("commit" in capture.value);

const captured = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) });

const reviewCapture = Effect.fn(function* (command: ReviewCommand, user: UserId, current: number) {
  const sql = yield* SqliteClient;

  if (!Predicate.isTagged(command, "Create")) return Option.none();

  const [owner] =
    yield* sql`SELECT service_market AS serviceMarket,locale,time_zone AS timeZone FROM ingestion_review_items WHERE user_id=${user} AND id=${command.id}`;

  const context = yield* Schema.decodeUnknownEffect(UserContext)(owner);

  return Option.some(
    yield* prepareSourcedCapture(
      { ...command.extraction, categoryId: command.categoryId, notes: Option.none() },
      { userId: user, current },
      { kind: "manual", context, revision: "user-reviewed-v1", reviewId: command.id }
    )
  );
});

const reviewStatements = Effect.fn(function* (
  refs: ReadonlyArray<{ id: string; revision: number }>,
  user: UserId,
  { current, expected }: { current: number; expected: string }
) {
  const sql = yield* SqliteClient;

  const rows = yield* Effect.forEach(
    refs,
    Effect.fnUntraced(function* (ref) {
      const [row] =
        yield* sql`SELECT r.statement_submission_id FROM ingestion_review_items r LEFT JOIN statement_submissions s ON s.id=r.statement_submission_id AND s.user_id=r.user_id WHERE r.id=${ref.id} AND r.user_id=${user} AND coalesce(r.workspace_state,'pending')=${expected} AND coalesce(r.workspace_revision,0)=${ref.revision} AND r.evidence_expires_at_ms>${current} AND s.hosted_session_id IS NULL AND (s.id IS NULL OR s.clarification_state!='abandoned')`;

      return yield* Effect.fromNullishOr(row);
    })
  ).pipe(Effect.catchNoSuchElement);

  return Option.map(
    rows,
    (found) =>
      new Set(
        found.flatMap((row) =>
          Predicate.isString(row.statement_submission_id) ? [row.statement_submission_id] : []
        )
      )
  );
});

const completeReviewStatements = Effect.fnUntraced(function* (
  statements: Iterable<string>,
  user: UserId,
  current: number
) {
  const sql = yield* SqliteClient;

  yield* Effect.forEach(
    statements,
    Effect.fnUntraced(function* (id) {
      yield* sql`UPDATE statement_backfill SET consumed_at_ms=coalesce(consumed_at_ms,${current}) WHERE user_id=${user} AND submission_id=${id}`;
      yield* sql`UPDATE statement_submissions SET clarification_state='completed',clarification_ended_at_ms=${current} WHERE user_id=${user} AND id=${id} AND clarification_state='awaiting' AND NOT EXISTS(SELECT 1 FROM ingestion_review_items WHERE statement_submission_id=${id} AND coalesce(workspace_state,'pending')='pending')`;
    }),
    { discard: true }
  );
});

export const prepareLocalReviewEdit = Effect.fn(function* (
  command: ReviewCommand,
  user: UserId,
  current: number
) {
  const sql = yield* SqliteClient;
  const refs = "items" in command ? command.items : [command];

  if (new Set(refs.map((ref) => ref.id)).size !== refs.length) return invalid();
  const expected = Predicate.isTagged(command, "Restore") ? "skipped" : "pending";
  const targets = refs.map((ref) => "review:" + ref.id);
  const eligible = yield* reviewStatements(refs, user, { current, expected });

  if (Option.isNone(eligible)) return invalid();
  const statements = eligible.value;
  const capture = yield* reviewCapture(command, user, current);

  if (captureRefused(capture)) return invalid();

  const draft = Predicate.isTagged(command, "SaveDraft")
    ? yield* Schema.encodeEffect(reviewDraftJson)(command.draft)
    : null;

  const status = { Create: "created", Skip: "skipped", Restore: "pending", SaveDraft: "pending" }[
    command._tag
  ];

  return prepareLocalWrite({
    targets,
    review: localReviewEditConfirmation(command, user),
    commit: Effect.gen(function* () {
      const transaction =
        Option.isSome(capture) && "commit" in capture.value
          ? (yield* Schema.decodeUnknownEffect(captured)((yield* capture.value.commit).body)).data
              .id
          : null;

      const details = yield* Effect.forEach(
        refs,
        Effect.fnUntraced(function* (ref) {
          const changed =
            yield* sql`UPDATE ingestion_review_items SET workspace_state=${status},workspace_revision=${ref.revision + 1},
        workspace_updated_at_ms=${current},workspace_archive_row_ref=coalesce(workspace_archive_row_ref,'review:'||id),
        transaction_id=${transaction}, draft_json=coalesce(${draft},draft_json)
        WHERE id=${ref.id} AND user_id=${user} AND coalesce(workspace_state,'pending')=${expected}
        AND coalesce(workspace_revision,0)=${ref.revision} AND evidence_expires_at_ms>${current} RETURNING id`;

          if (changed.length !== 1) {
            return yield* new CanonicalAdmissionUnavailable({ cause: "review_revision" });
          }

          const detail = yield* readOwnedDetail(user, ref.id, current);

          if (Option.isNone(detail)) {
            return yield* new CanonicalAdmissionUnavailable({ cause: "review_readback" });
          }

          return detail.value;
        })
      );

      if (Predicate.isTagged(command, "Create")) {
        yield* completeReviewStatements(statements, user, current);
      }

      return result(yield* Schema.encodeEffect(Schema.toCodecJson(ReviewEditResult))(details));
    }),
    premises: Array.from(statements, (id) => "statement:" + id),
  });
});
