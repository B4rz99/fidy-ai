import { DateTime, Effect, Option, Schema } from "effect";
import { SubscriptionCancellation } from "../../../src/core/subscription/contract";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { recordLivePATUse } from "../../../src/shell/tokens/operations";
import { newId } from "../../secret-material/operations";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
import {
  callerAuthority,
  callerScope,
  failedPreparation,
  isOAuthCaller,
  isPATCaller,
  refusedCredentialResponse,
  transactionFailure,
  transactionUnavailable,
} from "../../canonical-work/operations";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  CanonicalPreparationWork,
  CommittedMutationValue,
} from "../../canonical-operations/contract";

const operation = "subscription.cancelSubscription";
const CancellationRow = Schema.Struct({
  cancelled_at_ms: Schema.Int,
  paid_through_ms: Schema.Int,
  source_cancellation: SubscriptionCancellation.fields.sourceCancellation,
});
const Snapshot = Schema.Struct({
  attempt_id: Schema.String.check(Schema.isUUID()),
  payment_source_id: Schema.String.check(Schema.isUUID()),
  paid_through_ms: Schema.Int,
});
const readCancellation = (
  db: D1Database,
  userId: string
): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.tryPromise(() =>
    db
      .prepare(
        "SELECT cancelled_at_ms,paid_through_ms,source_cancellation FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) WHERE user_id=?"
      )
      .bind(userId)
      .first()
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CancellationRow)),
    Effect.map((row): Option.Option<CommittedMutationValue> => {
      const value = SubscriptionCancellation.make({
        cancelledAt: DateTime.makeUnsafe(row.cancelled_at_ms),
        paidThrough: DateTime.makeUnsafe(row.paid_through_ms),
        sourceCancellation: row.source_cancellation,
      });
      return Option.some({
        _tag: "Owner",
        payload: value,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(SubscriptionCancellation))(value),
      });
    }),
    Effect.orElseSucceed(() => Option.none())
  );

export const cancellationRefusal = (work: CanonicalPreparationWork): CanonicalMutationRefusal => ({
  code: "not_found",
  message: "No paid Subscription belongs to you.",
  record: () =>
    Effect.tryPromise(() =>
      prepareAuthorizedAuditCall({
        db: work.db,
        authority: callerAuthority(work),
        id: newId(),
        operation,
        outcome: "rejected",
        current: work.current,
        afterOwnerWrite: false,
      }).run()
    ).pipe(
      Effect.map((result) =>
        result.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
      ),
      Effect.orElseSucceed(() => "unavailable" as const)
    ),
  respond: (disposition) =>
    disposition === "credential_refused"
      ? refusedCredentialResponse(work)
      : Effect.succeed(
          disposition === "recorded"
            ? transactionFailure({
                code: "not_found",
                status: 404,
                message: "No paid Subscription belongs to you.",
              })
            : transactionUnavailable()
        ),
});

const cancellationStatements = (
  work: CanonicalPreparationWork,
  snapshot: typeof Snapshot.Type
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, current } = work;
  const authority = callerAuthority(work);
  const mutation = db
    .prepare(`UPDATE users SET cancellation_paid_attempt_id=CASE WHEN cancellation_cancelled_at_ms IS NULL THEN incoming.attempt_id ELSE cancellation_paid_attempt_id END,
    cancellation_payment_source_id=CASE WHEN cancellation_cancelled_at_ms IS NULL THEN incoming.payment_source_id ELSE cancellation_payment_source_id END,
    cancellation_cancelled_at_ms=coalesce(cancellation_cancelled_at_ms,incoming.cancelled_at_ms),
    cancellation_paid_through_ms=coalesce(cancellation_paid_through_ms,incoming.paid_through_ms),
    cancellation_source_cancellation=coalesce(cancellation_source_cancellation,incoming.source_cancellation),
    cancellation_verification_count=coalesce(cancellation_verification_count,0)
    FROM (SELECT s.user_id,s.attempt_id,a.payment_source_id,? AS cancelled_at_ms,? AS paid_through_ms,
      CASE WHEN source.method='daviplata' THEN 'void-pending' ELSE 'detached' END AS source_cancellation
      FROM subscription_standing s JOIN billing_attempts a ON a.id=s.attempt_id AND a.paid_starts_at_ms IS NOT NULL AND a.user_id=s.user_id
      JOIN card_payment_sources source ON source.id=a.payment_source_id AND source.user_id=s.user_id
      WHERE s.user_id=? AND s.attempt_id=? AND a.payment_source_id=?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})) incoming
    WHERE users.id=incoming.user_id`)
    .bind(
      current,
      snapshot.paid_through_ms,
      subject.userId,
      snapshot.attempt_id,
      snapshot.payment_source_id,
      ...authority.bindings
    );
  const audit = prepareAuthorizedAuditCall({
    db,
    authority,
    id: newId(),
    operation,
    outcome: "accepted",
    current,
    afterOwnerWrite: true,
  });
  return [
    ...(isPATCaller(subject)
      ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
          db.prepare(sql).bind(...params)
        )
      : []),
    mutation,
    audit,
  ];
};

export const prepareCancellation = (
  work: CanonicalPreparationWork
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const { db, subject } = work;
    const authority = callerAuthority(work);
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT s.attempt_id,a.payment_source_id,
    MIN(a.paid_ends_at_ms, COALESCE((SELECT MIN(ends_at_ms) FROM (SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL) AS billing_access_adjustments WHERE attempt_id=a.id),a.paid_ends_at_ms)) AS paid_through_ms
    FROM subscription_standing s JOIN billing_attempts a ON a.id=s.attempt_id AND a.paid_starts_at_ms IS NOT NULL AND a.user_id=s.user_id
     WHERE s.user_id=?
    AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(subject.userId, ...authority.bindings)
        .first()
    );
    if (row === null) return { _tag: "Refused", refusal: cancellationRefusal(work) } as const;
    const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(row);
    const revision = yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(snapshot);
    return {
      _tag: "Prepared",
      mutation: {
        requiredScope: callerScope(subject),

        commitGuards: Option.none(),
        oauthReview: isOAuthCaller(subject)
          ? Option.some(
              oauthMutationReview({
                db,
                revision,
                effect: `Cancelar futuras renovaciones de Pro. Conservar acceso pagado hasta ${DateTime.formatIso(DateTime.makeUnsafe(snapshot.paid_through_ms))}. Desvincular el medio de pago reutilizable.`,
                guard: {
                  sql: "SELECT 1 FROM subscription_standing WHERE user_id=? AND attempt_id=?",
                  params: [subject.userId, snapshot.attempt_id],
                },
              })
            )
          : Option.none(),
        guardRefusal: () => Effect.succeed(cancellationRefusal(work)),
        outcome: {
          _tag: "Owner",
          operation,
          collisionKey: Option.some(`subscription-cancellation:${subject.userId}`),
          guardFacts: Option.none(),
          read: readCancellation,
        },
        statements: cancellationStatements(work, snapshot),
      },
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));
