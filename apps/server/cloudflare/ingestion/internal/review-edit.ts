import type { ReviewEditWork } from "../contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { reviewedCapture } from "./review-create";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import {
  ReviewCommand,
  ReviewEditResult,
  type ReviewReference,
} from "../../../src/core/ingestion/contract";
import type {
  CanonicalMutationPreparation,
  OwnerOutcome,
  PreparedCanonicalMutation,
} from "../../canonical-operations/contract";
import {
  callerAuthority,
  callerScope,
  failedPreparation,
  isOAuthCaller,
  refusedPreparation,
} from "../../canonical-work/operations";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
import { readReviewDetail, reviewCompletion, reviewDraftJson } from "./review-store";
import { reviewAudit, reviewRefusal } from "./review-audit";

const operation = "ingestion.applyReviewEdit";
const references = (command: ReviewCommand): ReadonlyArray<ReviewReference> =>
  command._tag === "SaveDraft" || command._tag === "Create" ? [command] : command.items;
const selectionGuard = (
  work: ReviewEditWork["work"],
  command: ReviewCommand,
  ref: ReviewReference
): OwnedStatement => {
  const authority = callerAuthority(work);
  return {
    sql: `SELECT user_id FROM ingestion_review_sources WHERE user_id = ? AND id = ? AND revision = ? AND status = ? AND expires_at_ms > ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
    params: [
      work.subject.userId,
      ref.id,
      ref.revision,
      command._tag === "Restore" ? "skipped" : "pending",
      work.current,
      ...authority.bindings,
    ],
  };
};
const decisionStatus = (command: ReviewCommand): "pending" | "skipped" | "created" => {
  if (command._tag === "Create") return "created";
  return command._tag === "Skip" ? "skipped" : "pending";
};
const writeReview = ({
  work,
  command,
  ref,
  draft,
  transactionId,
}: Readonly<{
  work: ReviewEditWork["work"];
  command: ReviewCommand;
  ref: ReviewReference;
  draft: Option.Option<string>;
  transactionId: Option.Option<string>;
}>): D1PreparedStatement => {
  const authority = callerAuthority(work);
  const guard = selectionGuard(work, command, ref);
  return work.db
    .prepare(`INSERT INTO ingestion_review_state
    (id,user_id,status,revision,draft_json,transaction_id,expires_at_ms,updated_at_ms,created_at_ms)
    SELECT id,user_id,?,revision+1,${Option.isSome(draft) ? "?" : "draft_json"},${Option.isSome(transactionId) ? "?" : "NULL"},expires_at_ms,?,created_at_ms
    FROM ingestion_review_sources WHERE id = ? AND user_id = ? AND EXISTS (${guard.sql})
    AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
    ON CONFLICT(user_id,id) DO UPDATE SET status=excluded.status, revision=excluded.revision,
      draft_json=excluded.draft_json, transaction_id=excluded.transaction_id, updated_at_ms=excluded.updated_at_ms`)
    .bind(
      decisionStatus(command),
      ...Option.toArray(draft),
      ...Option.toArray(transactionId),
      work.current,
      ref.id,
      work.subject.userId,
      ...guard.params,
      ...authority.bindings
    );
};
const reviewOutcome = (refs: ReadonlyArray<ReviewReference>, current: number): OwnerOutcome => ({
  _tag: "Owner",
  operation,
  collisionKey: Option.none(),
  guardFacts: Option.none(),
  triggerRefusal: ({ db, subject, current: now }) =>
    Option.some(reviewRefusal({ db, subject, current: now })),
  read: (db, userId) =>
    Effect.gen(function* () {
      const items = yield* Effect.forEach(refs, (ref) =>
        readReviewDetail({ db, userId, id: ref.id, current })
      );
      if (items.some(Option.isNone)) return Option.none();
      const payload = items.flatMap(Option.toArray);
      return Option.some({
        _tag: "Owner" as const,
        payload,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(ReviewEditResult))(payload),
      });
    }).pipe(Effect.orElseSucceed(() => Option.none())),
});

const reviewOAuth = ({
  work,
  command,
  refs,
  guards,
  category,
}: Readonly<{
  work: ReviewEditWork["work"];
  command: ReviewCommand;
  refs: ReadonlyArray<ReviewReference>;
  guards: ReadonlyArray<OwnedStatement>;
  category: Option.Option<string>;
}>): PreparedCanonicalMutation["oauthReview"] =>
  isOAuthCaller(work.subject)
    ? Option.some(
        oauthMutationReview({
          db: work.db,
          effect: `${Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(ReviewCommand)))(command)}${Option.match(category, { onNone: () => "", onSome: (id) => ` Categoría de la nueva Transacción: ${id}.` })}`,
          revision: `${refs.map(({ id, revision }) => `${id}:${revision}`).join(",")}:${Option.getOrElse(category, () => "")}`,
          guard: {
            sql: `SELECT 1 WHERE ${guards.map(({ sql }) => `EXISTS (${sql})`).join(" AND ")}`,
            params: guards.flatMap(({ params }) => params),
          },
        })
      )
    : Option.none();
const futureReview = (command: ReviewCommand, current: number): boolean =>
  command._tag === "Create" && DateTime.toEpochMillis(command.extraction.occurredAt) > current;
/** Every reference rechecks its revision, original expiry and caller in the same D1 unit. */
export const prepareReviewEdit = ({
  work,
  command,
}: Readonly<{
  work: ReviewEditWork["work"];
  command: ReviewCommand;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    if (futureReview(command, work.current)) return refusedPreparation(reviewRefusal(work));
    const refs = references(command);
    if (new Set(refs.map(({ id }) => id)).size !== refs.length) {
      return refusedPreparation(reviewRefusal(work));
    }
    const guards = refs.map((ref) => selectionGuard(work, command, ref));
    const eligible = yield* Effect.forEach(guards, (guard) => eligibleReview(work.db, guard));
    if (eligible.some((row) => row === null)) return refusedPreparation(reviewRefusal(work));
    const draft =
      command._tag === "SaveDraft"
        ? Option.some(yield* Schema.encodeEffect(reviewDraftJson)(command.draft))
        : Option.none();
    const capture =
      command._tag === "Create"
        ? Option.some(
            yield* reviewedCapture({ work, command, guard: selectionGuard(work, command, command) })
          )
        : Option.none();
    return {
      _tag: "Prepared" as const,
      mutation: {
        oauthReview: reviewOAuth({
          work,
          command,
          refs,
          guards,
          category: Option.map(capture, (value) => value.categoryId),
        }),
        requiredScope: callerScope(work.subject),
        auditBudget: "shared" as const,
        commitGuards: Option.none(),
        guardRefusal: (current) => Effect.succeed(reviewRefusal(current)),
        statements: [
          ...Option.toArray(capture).flatMap(({ statements }) => statements),
          ...refs.flatMap((ref) => [
            writeReview({
              work,
              command,
              ref,
              draft,
              transactionId: Option.map(capture, (value) => value.transactionId),
            }),
            work.db.prepare(reviewCompletion),
          ]),
          ...reviewAudit({ work, operation, accepted: true }),
        ],
        outcome: reviewOutcome(refs, work.current),
      },
    };
  }).pipe(Effect.orElseSucceed(failedPreparation));

const eligibleReview = (
  db: D1Database,
  guard: OwnedStatement
): Effect.Effect<unknown, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare(guard.sql)
      .bind(...guard.params)
      .first()
  );
