import { Array, Effect, Option, Schema, Struct } from "effect";
import { BudgetCrossing, BudgetId } from "../../../src/core/budgets/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { ConsentRecordId } from "../../../src/core/consent/contract";
import type { UserId } from "../../../src/core/identity/contract";
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
