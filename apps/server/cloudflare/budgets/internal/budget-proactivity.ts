import { Array, Effect, Option, Schema, Struct } from "effect";
import { BudgetCrossing, BudgetId } from "../../../src/core/budgets/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { ConsentRecordId } from "../../../src/core/consent/contract";
import { type UserId, UserId as UserIdSchema } from "../../../src/core/identity/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareConsentAction } from "../../consent/operations";
import { BudgetCrossingGroup, BudgetCrossingUnavailable } from "../contract";

const maximumGroups = 16;
const maximumRows = 32;
const Row = Schema.Struct({
  budget_id: BudgetId,
  from_utc: Schema.DateTimeUtcFromString,
  time_zone: IanaTimeZone,
  threshold: BudgetCrossing.fields.threshold,
  delivery_group_id: BudgetCrossingGroup.fields.id,
  consent_grant_id: Schema.OptionFromNullOr(ConsentRecordId),
  crossing_json: Schema.fromJsonString(Schema.toCodecJson(BudgetCrossing)),
});
const Snapshot = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Struct(Struct.omit(BudgetCrossing.fields, ["threshold"])))
);
const matchesKey = (row: typeof Row.Type): boolean =>
  row.budget_id === row.crossing_json.budgetId &&
  row.threshold === row.crossing_json.threshold &&
  row.time_zone === row.crossing_json.period.timeZone &&
  row.from_utc.epochMilliseconds === row.crossing_json.period.from.epochMilliseconds;
const decodeGroup = (
  group: Array.NonEmptyReadonlyArray<typeof Row.Type>
): Effect.Effect<BudgetCrossingGroup, BudgetCrossingUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    if (!group.every(matchesKey)) return yield* new BudgetCrossingUnavailable();
    const snapshots = yield* Effect.forEach(group, (row) =>
      Schema.encodeEffect(Snapshot)(row.crossing_json)
    );
    const grant = Option.getOrElse(group[0].consent_grant_id, () => "");
    if (
      snapshots.some((snapshot) => snapshot !== snapshots[0]) ||
      group.some((row) => Option.getOrElse(row.consent_grant_id, () => "") !== grant)
    ) {
      return yield* new BudgetCrossingUnavailable();
    }
    if (new Set(group.map((row) => row.threshold)).size !== group.length) {
      return yield* new BudgetCrossingUnavailable();
    }
    return yield* Schema.decodeEffect(Schema.toType(BudgetCrossingGroup))({
      id: group[0].delivery_group_id,
      grantId: group[0].consent_grant_id,
      crossings: Array.map(group, (row) => row.crossing_json),
    });
  });
export const preparePublication = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    id: string;
    now: number;
    proof: OwnedStatement;
  }>
): D1PreparedStatement =>
  prepareConsentAction({
    db: input.db,
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `UPDATE budget_crossing_publications SET materialized_at_ms=? WHERE user_id=? AND delivery_group_id=? AND materialized_at_ms IS NULL AND EXISTS (${input.proof.sql})`,
      params: [input.now, input.userId, input.id, ...input.proof.params],
    },
  });

export const findFirstCreation = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<BudgetId>, BudgetCrossingUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT budget_id FROM budget_first_creation WHERE user_id=? AND offer_requested_at_ms IS NULL",
          params: [input.userId],
        },
      }).first()
    );
    return raw === null
      ? Option.none()
      : Option.some(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ budget_id: BudgetId }))(raw)).budget_id
        );
  }).pipe(Effect.mapError(() => new BudgetCrossingUnavailable()));
export const prepareFirstOffer = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    budgetId: BudgetId;
    now: number;
    proof: OwnedStatement;
  }>
): D1PreparedStatement =>
  prepareConsentAction({
    db: input.db,
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `UPDATE budget_first_creation SET offer_requested_at_ms=? WHERE user_id=? AND budget_id=? AND offer_requested_at_ms IS NULL AND EXISTS (${input.proof.sql})`,
      params: [input.now, input.userId, input.budgetId, ...input.proof.params],
    },
  });

export const noteEvaluation = (
  input: Readonly<{ db: D1Database; userId: UserId; now: number }>
): Effect.Effect<void, BudgetCrossingUnavailable> =>
  Effect.tryPromise(() =>
    input.db.batch([
      input.db
        .prepare(
          "UPDATE budget_crossing_publications SET last_evaluated_at_ms=? WHERE user_id=? AND materialized_at_ms IS NULL"
        )
        .bind(input.now, input.userId),
      input.db
        .prepare(
          "UPDATE budget_first_creation SET last_evaluated_at_ms=? WHERE user_id=? AND offer_requested_at_ms IS NULL"
        )
        .bind(input.now, input.userId),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new BudgetCrossingUnavailable())
  );
export const discoverUsers = (
  input: Readonly<{ db: D1Database }>
): Effect.Effect<ReadonlyArray<UserId>, BudgetCrossingUnavailable> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT user_id FROM (SELECT user_id,last_evaluated_at_ms,detected_at_ms AS pending_at FROM budget_crossing_publications WHERE materialized_at_ms IS NULL UNION ALL SELECT user_id,last_evaluated_at_ms,created_at_ms AS pending_at FROM budget_first_creation WHERE offer_requested_at_ms IS NULL) GROUP BY user_id ORDER BY min(last_evaluated_at_ms),min(pending_at) LIMIT ?"
        )
        .bind(maximumGroups)
        .all()
    );
    return (yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserIdSchema })).check(
        Schema.isMaxLength(maximumGroups)
      )
    )(result.results)).map((row) => row.user_id);
  }).pipe(Effect.mapError(() => new BudgetCrossingUnavailable()));

/** Only pending same-User frozen facts are observed; a later grant is never consulted. */
export const readGroups = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<ReadonlyArray<BudgetCrossingGroup>, BudgetCrossingUnavailable> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT budget_id,from_utc,time_zone,threshold,delivery_group_id,consent_grant_id,crossing_json FROM (SELECT a.budget_id,a.from_utc,a.time_zone,a.threshold,a.delivery_group_id,a.consent_grant_id,a.crossing_json FROM budget_threshold_alerts AS a WHERE a.user_id=? AND a.delivery_group_id IN (SELECT p.delivery_group_id FROM budget_crossing_publications AS p WHERE p.user_id=? AND p.materialized_at_ms IS NULL ORDER BY p.detected_at_ms,p.delivery_group_id LIMIT ?) ORDER BY a.delivery_group_id,a.threshold LIMIT ?) WHERE 1=1",
          params: [input.userId, input.userId, maximumGroups, maximumRows],
        },
      }).all()
    );
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Row).check(Schema.isMaxLength(maximumRows))
    )(result.results);
    return yield* Effect.forEach(
      Object.values(Array.groupBy(rows, (row) => row.delivery_group_id)),
      decodeGroup
    );
  }).pipe(Effect.mapError(() => new BudgetCrossingUnavailable()));
