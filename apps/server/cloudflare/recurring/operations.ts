import { withStoreCapacity } from "../runtime/sqlite/operations";
import {
  dispatchSeries,
  readSeries,
  recoverSeries,
  repairSeriesAlarm,
} from "./internal/sqlite-series";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect } from "effect";
import { type UserId } from "../../src/core/identity/contract";

export const ownsLocalRecurringSeries = Effect.fn(function* (user: UserId, id: string) {
  const sql = yield* SqliteClient;

  return (
    (yield* sql`SELECT 1 FROM recurring_series WHERE user_id=${user} AND id=${id}`).length === 1
  );
});

export const dispatchLocalRecurringSeries: typeof dispatchSeries = (unit) => dispatchSeries(unit);

export const recoverLocalRecurringSeries: typeof recoverSeries = (current, storage, owns) =>
  recoverSeries(current, storage, owns);

export const repairLocalRecurringAlarm = Effect.fnUntraced(function* (
  current: number,
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  return yield* withStoreCapacity("required")(repairSeriesAlarm(current, storage, owns));
});

export const readLocalRecurringSeries: typeof readSeries = (...args) => readSeries(...args);
