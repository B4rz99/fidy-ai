import { DateTime, Effect, Option, Schema } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { RecurringWorkspaceQuery } from "../../../src/shell/recurring-plans/contract";
import { type RecurringPlanningUnavailable, type RecurringReadProjection } from "../contract";
import { decodeReadProjection, preparePlanningRows, prepareSelectedDocument } from "./store";

export const workspaceMonths = (
  query: typeof RecurringWorkspaceQuery.Type
): ReadonlyArray<string> => {
  const prior = query.previousMonth ?? monthOffset(query.month, -1);
  return [
    ...new Set(
      [prior, query.month].flatMap((month) =>
        [-1, 0, 1].map((offset) => monthOffset(month, offset))
      )
    ),
  ].sort();
};
const monthLength = 7;
const monthOffset = (month: string, offset: number): string =>
  DateTime.formatIsoDateUtc(
    DateTime.add(DateTime.makeUnsafe(`${month}-01`), { months: offset })
  ).slice(0, monthLength);

const revisionSelection = (
  users: OwnedStatement,
  months: ReadonlyArray<string>
): OwnedStatement => {
  const windows = months.map((month) => ({
    from: `${month}-01`,
    through: `${monthOffset(month, 1)}-01`,
  }));
  const point = (kind: "MIN" | "MAX", condition: string): string =>
    `(SELECT ${kind}(r.from_date) FROM recurring_plan_revisions r WHERE r.user_id=p.user_id AND r.plan_id=p.id ${condition})`;
  return {
    sql: `WITH owner AS MATERIALIZED (${users.sql}), windows AS (
    SELECT json_extract(value,'$.from') lo,json_extract(value,'$.through') hi FROM json_each(?)
  ), plans AS MATERIALIZED (SELECT user_id,id FROM recurring_plans WHERE user_id=(SELECT userId FROM owner)), needed AS (
    SELECT p.user_id,p.id AS plan_id,j.value AS from_date FROM plans p
      JOIN json_each(json_array(${point("MIN", "")},${point("MAX", "")})) j
    UNION SELECT p.user_id,p.id,${point("MAX", "AND r.from_date<=w.lo")} FROM plans p CROSS JOIN windows w
    UNION SELECT r.user_id,r.plan_id,r.from_date FROM plans p CROSS JOIN windows w
      JOIN recurring_plan_revisions r ON r.user_id=p.user_id AND r.plan_id=p.id AND r.from_date>=w.lo AND r.from_date<w.hi
    UNION SELECT p.user_id,p.id,${point("MAX", "AND r.from_date<=m.local_date")} FROM plans p
      JOIN recurring_plan_fulfillments m ON m.user_id=p.user_id AND m.plan_id=p.id
    UNION SELECT p.user_id,p.id,${point("MAX", "AND r.from_date<=m.local_date")} FROM plans p
      JOIN recurring_plan_exceptions m ON m.user_id=p.user_id AND m.plan_id=p.id
  ) SELECT json_object('planId',r.plan_id,'position',r.position,'from',r.from_date,'plan',json(r.plan_json)) AS body
    FROM needed n JOIN recurring_plan_revisions r ON r.user_id=n.user_id AND r.plan_id=n.plan_id AND r.from_date=n.from_date
    ORDER BY r.position LIMIT 10001`,
    params: [
      ...users.params,
      Schema.encodeSync(
        Schema.fromJsonString(
          Schema.Array(Schema.Struct({ from: Schema.String, through: Schema.String }))
        )
      )(windows),
    ],
  };
};

export const prepareReadProjection = ({
  db,
  users,
  query,
}: Readonly<{
  db: D1Database;
  users: OwnedStatement;
  query: typeof RecurringWorkspaceQuery.Type;
}>): Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  decode: (
    rows: ReadonlyArray<D1Result>
  ) => Effect.Effect<RecurringReadProjection, RecurringPlanningUnavailable>;
}> => {
  const months = workspaceMonths(query);
  if (query.view !== "compact") {
    const full = prepareSelectedDocument({ db, users });
    return {
      statements: full.statements,
      decode: (rows): Effect.Effect<RecurringReadProjection, RecurringPlanningUnavailable> =>
        full
          .decode(rows)
          .pipe(Effect.map((document) => ({ schedule: document, editing: document, months }))),
    };
  }
  const source = preparePlanningRows({
    db,
    users,
    revisions: Option.some(revisionSelection(users, months)),
  });
  return {
    statements: source.statements,
    decode: (rows) =>
      source.decode(rows).pipe(
        Effect.flatMap(decodeReadProjection),
        Effect.map((projection) => ({ ...projection, months }))
      ),
  };
};
