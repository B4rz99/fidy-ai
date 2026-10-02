import { prepareUserContext } from "../../identity/user-context/operations";
import { UserId } from "@fidy/server/agent-runtime";
import { Clock, Data, Effect, Option, Schema } from "effect";

class ProjectionRepairFailed extends Data.TaggedError("ProjectionRepairFailed") {}

const pageSize = 256;
const usersPerSweep = 4;
const State = Schema.Struct({
  readiness: Schema.Literals([
    "ready",
    "linking",
    "dirty",
    "clearing-buckets",
    "clearing-digits",
    "clearing",
    "rebuilding",
  ]),
  version: Schema.Int,
  cursor_id: Schema.String,
});
const Subject = Schema.Struct({ user_id: UserId });

const markForRepair = (db: D1Database, userId: string, nowMs: number): Promise<void> =>
  db
    .batch([
      prepareUserContext({
        db,
        userId: UserId.make(userId),
        statement: {
          sql: `INSERT OR IGNORE INTO dashboard_projection_state
          (user_id, version, readiness) SELECT userId, 1, 'clearing-buckets' FROM identity_user_context`,
          params: [],
        },
      }),
      db
        .prepare(`UPDATE dashboard_projection_state SET readiness = 'clearing-buckets', cursor_id = ''
      WHERE user_id = ? AND (readiness IN ('dirty', 'linking') OR version != 1)`)
        .bind(userId),
      db
        .prepare("UPDATE dashboard_projection_state SET attempted_at_ms = ? WHERE user_id = ?")
        .bind(nowMs, userId),
    ])
    .then(() => undefined);

type RepairTable =
  | "dashboard_projection_bucket"
  | "dashboard_projection_digit"
  | "dashboard_projection_leaf";

const clearingPhases = {
  "clearing-buckets": { table: "dashboard_projection_bucket", next: "clearing-digits" },
  "clearing-digits": { table: "dashboard_projection_digit", next: "clearing" },
  clearing: { table: "dashboard_projection_leaf", next: "rebuilding" },
} as const satisfies Record<string, Readonly<{ table: RepairTable; next: string }>>;

type ClearingPhase = keyof typeof clearingPhases;
const clearingPhase = (state: (typeof State.Type)["readiness"]): Option.Option<ClearingPhase> =>
  state === "clearing-buckets" || state === "clearing-digits" || state === "clearing"
    ? Option.some(state)
    : Option.none();

const clearPage = ({
  db,
  userId,
  table,
  phase,
  next,
}: Readonly<{
  db: D1Database;
  userId: string;
  table: RepairTable;
  phase: string;
  next: string;
}>): Promise<void> => {
  const key = table === "dashboard_projection_leaf" ? "id" : "rowid";
  return db
    .batch([
      // No digit or bucket subtraction is performed during clearing; concurrent writes continue
      // to refresh leaves and are included when the canonical effective source is replayed.
      db
        .prepare(`DELETE FROM ${table} WHERE user_id = ? AND ${key} IN
      (SELECT ${key} FROM ${table} WHERE user_id = ? ORDER BY ${key} LIMIT ${pageSize})`)
        .bind(userId, userId),
      db
        .prepare(`UPDATE dashboard_projection_state SET readiness = ?, cursor_id = ''
      WHERE user_id = ? AND readiness = ?
        AND NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id = ?)`)
        .bind(next, userId, phase, userId),
    ])
    .then(() => undefined);
};

const rebuildPage = (db: D1Database, userId: string, previousCursor: string): Promise<void> =>
  db
    .batch([
      db
        .prepare(`INSERT OR IGNORE INTO dashboard_projection_leaf
      (user_id, id, amount, currency, direction, category_id, counterparty, notes,
        occurred_at, created_at, revision)
      SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
        occurred_at, created_at, revision
      FROM dashboard_effective_source WHERE user_id = ? AND id >
        (SELECT cursor_id FROM dashboard_projection_state WHERE user_id = ?)
      ORDER BY id LIMIT ${pageSize}`)
        .bind(userId, userId),
      db
        .prepare(`UPDATE dashboard_projection_state SET cursor_id = COALESCE(
      (SELECT id FROM dashboard_effective_source WHERE user_id = ?
        AND id > dashboard_projection_state.cursor_id ORDER BY id LIMIT 1 OFFSET ${pageSize - 1}),
      (SELECT MAX(id) FROM dashboard_effective_source WHERE user_id = ?
        AND id > dashboard_projection_state.cursor_id), cursor_id)
      WHERE user_id = ? AND readiness = 'rebuilding'`)
        .bind(userId, userId, userId),
      db
        .prepare(`UPDATE dashboard_projection_state SET readiness = 'dirty'
      WHERE user_id = ? AND readiness = 'rebuilding' AND EXISTS (
        SELECT 1 FROM (SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
          occurred_at, created_at, revision FROM dashboard_effective_source
          WHERE user_id = ? AND id > ?
          ORDER BY id LIMIT ${pageSize}) effective
        LEFT JOIN dashboard_projection_leaf leaf ON leaf.user_id = effective.user_id
          AND leaf.id = effective.id
        WHERE leaf.id IS NULL OR leaf.amount != effective.amount
          OR leaf.currency != effective.currency OR leaf.direction != effective.direction
          OR leaf.category_id != effective.category_id OR leaf.occurred_at != effective.occurred_at
          OR leaf.created_at != effective.created_at OR leaf.revision != effective.revision
          OR leaf.counterparty IS NOT effective.counterparty OR leaf.notes IS NOT effective.notes)`)
        .bind(userId, userId, previousCursor),
      db
        .prepare(`UPDATE dashboard_projection_state SET version = 1, readiness = 'ready'
      WHERE user_id = ? AND readiness = 'rebuilding'
        AND NOT EXISTS (SELECT 1 FROM dashboard_effective_source effective
          WHERE effective.user_id = ? AND effective.id > dashboard_projection_state.cursor_id)
        AND NOT EXISTS (SELECT 1 FROM transaction_reconciliation_decisions decision
          WHERE decision.user_id = ? AND (
            (decision.state = 'linked' AND (SELECT COUNT(*) FROM transaction_reconciliation_members member
              WHERE member.user_id = decision.user_id
                AND member.first_transaction_id = decision.first_transaction_id
                AND member.second_transaction_id = decision.second_transaction_id) != 2)
            OR (decision.state = 'keep-separate' AND EXISTS
              (SELECT 1 FROM transaction_reconciliation_members member
                WHERE member.user_id = decision.user_id
                  AND member.first_transaction_id = decision.first_transaction_id
                  AND member.second_transaction_id = decision.second_transaction_id))))`)
        .bind(userId, userId, userId),
    ])
    .then(() => undefined);

/** Repair one User's projection in bounded pages; views stay unavailable until guarded cutover. */
export const repairDashboardProjection = ({
  db,
  userId,
}: Readonly<{
  db: D1Database;
  userId: string;
}>): Effect.Effect<"ready" | "pending", ProjectionRepairFailed> =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise(() => markForRepair(db, userId, nowMs));
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT version, readiness, cursor_id FROM dashboard_projection_state WHERE user_id = ?"
        )
        .bind(userId)
        .first()
    );
    const state = Schema.decodeUnknownOption(State)(raw);
    if (Option.isNone(state)) return "pending" as const;
    if (state.value.readiness === "ready" && state.value.version === 1) return "ready" as const;
    const phase = clearingPhase(state.value.readiness);
    if (Option.isSome(phase)) {
      yield* Effect.tryPromise(() =>
        clearPage({ db, userId, phase: phase.value, ...clearingPhases[phase.value] })
      );
    } else if (state.value.readiness === "rebuilding") {
      yield* Effect.tryPromise(() => rebuildPage(db, userId, state.value.cursor_id));
    }
    const after = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT version, readiness, cursor_id FROM dashboard_projection_state WHERE user_id = ?"
        )
        .bind(userId)
        .first()
    );
    return Schema.decodeUnknownOption(State)(after).pipe(
      Option.match({
        onNone: () => "pending" as const,
        onSome: (value) =>
          value.version === 1 && value.readiness === "ready"
            ? ("ready" as const)
            : ("pending" as const),
      })
    );
  }).pipe(Effect.mapError(() => new ProjectionRepairFailed()));

/** Advance at most four incomplete Users once per private scheduled tick. */
export const repairDashboardProjections = (
  db: D1Database
): Effect.Effect<void, ProjectionRepairFailed> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT user_id
      FROM dashboard_projection_state WHERE version != 1 OR readiness != 'ready'
      ORDER BY attempted_at_ms, user_id LIMIT ${usersPerSweep}`)
        .all()
    );
    const subjects = Option.all(
      result.results.map((row) => Schema.decodeUnknownOption(Subject)(row))
    );
    if (Option.isNone(subjects)) return yield* new ProjectionRepairFailed();
    for (const { user_id: userId } of subjects.value) {
      yield* repairDashboardProjection({ db, userId });
    }
  }).pipe(Effect.mapError(() => new ProjectionRepairFailed()));
