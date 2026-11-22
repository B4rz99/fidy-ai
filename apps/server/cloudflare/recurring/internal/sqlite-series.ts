import { ConsentSubject } from "../../../src/shell/consent/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { UserContext, UserId } from "../../../src/core/identity/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { type CanonicalRejection, validationRejection } from "../../canonical-admission/contract";
import {
  canonicalAdmissionUnavailable,
  runLocalMutation,
} from "../../canonical-admission/operations";
import { preserveStoreAlarm, withStoreAdmission } from "../../runtime/sqlite/operations";
import { readLocalFactPage, readLocalFactSnapshot } from "../../transactions/operations";
import { RecurringUnavailable, recurringDiscoveryIntervalMs } from "../contract";
import { type EvaluationStore, advanceEvaluation } from "./evaluation";
import { pageSize } from "./models";
import { Cursor, maximumCursorLength, pageData, readStatus } from "./query";

const unavailable = (): RecurringUnavailable => new RecurringUnavailable({ cause: Option.none() });

const weekMs = 604800000;

const checkpointDelayMs = 60_000;

const schedule = Schema.Struct({
  phase: Schema.Literals(["complete", "scan", "detect"]),
  revision: Schema.Int,
  evaluated_at_ms: Schema.NullOr(Schema.Int),
});

const readOwner = protectConsentStatement({
  subject: ConsentSubject.Owner({ column: "users.id" }),
  requirement: "active",
  statement: {
    sql: "SELECT id,service_market AS serviceMarket,locale,time_zone AS timeZone FROM users WHERE lifetime_registered=1",
    params: [],
  },
});

const localEvaluation = (
  sql: SqliteClient,
  context: UserContext & { id: UserId }
): EvaluationStore => {
  const user = context.id;

  return {
    userId: user,
    context: Effect.succeed(context),
    select: (statement, params) => sql.unsafe(statement, params).pipe(Effect.mapError(unavailable)),
    commit: (_revision, statements) =>
      Effect.forEach(statements, ({ sql: query, params }) => sql.unsafe(query, params), {
        discard: true,
      }).pipe(Effect.mapError(unavailable)),
    facts: (_revision, cursor) =>
      readLocalFactPage(user, cursor).pipe(
        Effect.provideService(SqliteClient, sql),
        Effect.asSome,
        Effect.mapError(unavailable)
      ),
  };
};

const ownerSchedule = Effect.fn(function* (current: number, owns: (id: string) => boolean) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql.unsafe(readOwner.sql, readOwner.params);

  if (row === undefined) return Option.none();

  const context = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: UserId, ...UserContext.fields })
  )(row);

  if (!owns(context.id)) return yield* unavailable();
  const observed = yield* readLocalFactSnapshot(context.id);

  if (Option.isNone(observed)) return Option.none();
  const snapshot = observed.value;

  const [last] =
    yield* sql`SELECT phase,revision,evaluated_at_ms FROM recurring_evaluation_records WHERE kind='progress' AND user_id=${context.id}`;

  if (last === undefined) {
    return Option.some({
      context,
      snapshot,
      due: snapshot.firstCapturedAt.epochMilliseconds + recurringDiscoveryIntervalMs,
    });
  }

  const status = yield* Schema.decodeUnknownEffect(schedule)(last);

  if (status.phase !== "complete") return Option.some({ context, snapshot, due: current });

  if (status.revision === snapshot.revision) return Option.none();
  const due = status.evaluated_at_ms === null ? current : status.evaluated_at_ms + weekMs;

  return Option.some({ context, snapshot, due });
});

export const repairSeriesAlarm = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  const pending = yield* ownerSchedule(current, owns);

  return Option.isSome(pending)
    ? yield* preserveStoreAlarm(storage, Math.max(current, pending.value.due))
    : false;
});

export const recoverSeries = Effect.fn(function* (
  current: number,
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const pending = yield* ownerSchedule(current, owns);
      const idle = { attempted: 0, failed: 0 };

      if (Option.isNone(pending)) return idle;
      const { context, snapshot, due } = pending.value;

      if (due > current) {
        yield* preserveStoreAlarm(storage, due);

        return idle;
      }

      yield* admitGrowth;
      const store = localEvaluation(yield* SqliteClient, context);
      yield* advanceEvaluation({ work: store, snapshot });
      yield* preserveStoreAlarm(storage, current + checkpointDelayMs);

      return { attempted: 1, failed: 0 };
    })
  );
});

const invalid = (): CanonicalRejection => validationRejection("Invalid recurring-series cursor.");

const browse = Effect.fn(function* (cursor: Option.Option<typeof Cursor.Type>, user: UserId) {
  const sql = yield* SqliteClient;
  const source = yield* readLocalFactSnapshot(user);

  const [progress] =
    yield* sql`SELECT evaluated_revision AS evaluatedRevision,phase,evaluated_at_ms AS evaluatedAt FROM recurring_evaluation_records WHERE kind='progress' AND user_id=${user}`;

  const status = yield* readStatus(
    Option.isNone(source)
      ? undefined
      : {
          evaluatedRevision: null,
          phase: null,
          evaluatedAt: null,
          ...progress,
          factRevision: source.value.revision,
        }
  );

  if (
    Option.isSome(cursor) &&
    cursor.value.revision !== Option.getOrNull(status)?.evaluatedRevision
  ) {
    return yield* invalid();
  }

  const start = Option.match(cursor, {
    onNone: () => ({ currency: "", key: "", id: "" }),
    onSome: (entry) => entry,
  });

  const rows =
    yield* sql`SELECT currency,counterparty_key,id,series_json FROM recurring_series WHERE user_id=${user} AND valid=1 AND (currency,counterparty_key,id)>(${start.currency},${start.key},${start.id}) ORDER BY currency,counterparty_key,id LIMIT ${pageSize + 1}`;

  const data = yield* pageData({ raw: rows, status });

  return { status: 200, outcome: "success" as const, body: { data, next: [] } };
});

const decodeCursor = (
  raw: Option.Option<string>
): Option.Option<Option.Option<typeof Cursor.Type>> => {
  if (Option.isNone(raw)) return Option.some(Option.none());

  if (raw.value.length > maximumCursorLength) return Option.none();

  return Option.map(Schema.decodeOption(Schema.fromJsonString(Cursor))(raw.value), Option.some);
};

export const dispatchSeries = Effect.fn(
  function* (unit: {
    request: Request;
    storage: DurableObjectStorage;
    owns: (user: string) => boolean;
    operation: CatalogOperation;
  }) {
    const decoded = decodeCursor(
      Option.fromNullishOr(new URL(unit.request.url).searchParams.get("cursor"))
    );

    return yield* runLocalMutation({ ...unit, input: Effect.succeed(decoded), work: browse });
  },
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const readSeries = Effect.fn(function* (cursor: Option.Option<string>, user: UserId) {
  const selected = decodeCursor(cursor);

  if (Option.isNone(selected)) return yield* invalid();

  return yield* browse(selected.value, user);
});
