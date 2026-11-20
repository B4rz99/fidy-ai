import { Clock, Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  EmailCapacityCommand,
  type IngestionCapacity,
  mediaCapacityUrl,
  outstandingEmailLimit,
  retainedEmailLimit,
  retainedMediaLimit,
} from "../contract";
import type { StoreCapacityUnavailable } from "../../runtime/sqlite/contract";
import { preserveStoreAlarm, withStoreAdmission } from "../../runtime/sqlite/operations";

const applied = 204,
  stale = 409,
  full = 429;
const status = (code: number): Response => new Response(null, { status: code });
const pools = {
  email: {
    table: "email_capacity_slots",
    retained: retainedEmailLimit,
    outstanding: outstandingEmailLimit,
  },
  media: {
    table: "media_capacity_slots",
    retained: retainedMediaLimit,
    outstanding: retainedMediaLimit,
  },
};
type Pool = (typeof pools)[IngestionCapacity];
const offerSlot = Effect.fn(function* (now: number, pool: Pool) {
  const sql = yield* SqliteClient;
  const [available] =
    yield* sql`SELECT slot,generation FROM ${sql(pool.table)} WHERE receipt IS NULL OR expires_at_ms<=${now} ORDER BY slot LIMIT 1`;
  if (available !== undefined) return Response.json(available);
  const [next] = yield* sql`SELECT coalesce(max(slot),0)+1 AS slot FROM ${sql(pool.table)}`;
  const slot = yield* Schema.decodeUnknownEffect(Schema.Int)(next?.slot);
  return slot <= pool.retained ? Response.json({ slot, generation: 0 }) : status(full);
});
type Target = Exclude<typeof EmailCapacityCommand.Type, { _tag: "Offer" }>;
const slotState = Effect.fn(function* (
  { slot, generation, receipt, expires }: Target,
  now: number,
  pool: Pool
) {
  const sql = yield* SqliteClient;
  const [prior] =
    yield* sql`SELECT generation,receipt,expires_at_ms FROM ${sql(pool.table)} WHERE slot=${slot}`;
  if (prior === undefined) return { exact: false, available: generation === 0 };
  return {
    exact:
      prior.receipt === receipt &&
      prior.generation === generation + 1 &&
      prior.expires_at_ms === expires,
    available:
      prior.generation === generation &&
      (prior.receipt === null || Number(prior.expires_at_ms) <= now),
  };
});
const claimSlot = Effect.fn(function* (
  { slot, generation, receipt, expires }: Target,
  { exact, available }: { exact: boolean; available: boolean },
  {
    now,
    pool,
    storage,
    admitGrowth,
  }: {
    now: number;
    pool: Pool;
    storage: DurableObjectStorage;
    admitGrowth: Effect.Effect<void, StoreCapacityUnavailable>;
  }
) {
  if (expires <= now) return status(stale);
  if (exact) return status(applied);
  if (!available) return status(stale);
  const sql = yield* SqliteClient;
  const [pressure] =
    yield* sql`SELECT count(*) AS active FROM ${sql(pool.table)} WHERE state='outstanding' AND expires_at_ms>${now}`;
  if ((yield* Schema.decodeUnknownEffect(Schema.Int)(pressure?.active)) >= pool.outstanding) {
    return status(full);
  }
  yield* admitGrowth;
  yield* sql`INSERT INTO ${sql(pool.table)}(slot,generation,receipt,expires_at_ms,state) VALUES(${slot},${generation + 1},${receipt},${expires},'outstanding') ON CONFLICT(slot) DO UPDATE SET generation=excluded.generation,receipt=excluded.receipt,expires_at_ms=excluded.expires_at_ms,state=excluded.state`;
  yield* preserveStoreAlarm(storage, expires);
  return status(applied);
});

export const ingestionCapacityRequest = Effect.fn(function* (
  request: Request,
  storage: DurableObjectStorage
) {
  const pool = request.url === mediaCapacityUrl ? pools.media : pools.email;
  const command = yield* Schema.decodeUnknownEffect(EmailCapacityCommand)(
    yield* Effect.tryPromise(() => request.json())
  );
  if (command._tag !== "Offer" && command.slot > pool.retained) return status(stale);
  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (command._tag === "Offer") return yield* offerSlot(now, pool);

      const state = yield* slotState(command, now, pool);
      const sql = yield* SqliteClient;
      switch (command._tag) {
        case "Claim":
          return yield* claimSlot(command, state, { now, pool, storage, admitGrowth });
        case "Settle":
          if (state.exact) {
            yield* sql`UPDATE ${sql(pool.table)} SET state='retained' WHERE slot=${command.slot}`;
          }
          break;
        case "Release":
          if (state.exact || state.available) {
            yield* sql`INSERT INTO ${sql(pool.table)}(slot,generation) VALUES(${command.slot},${command.generation + 1}) ON CONFLICT(slot) DO UPDATE SET generation=excluded.generation,receipt=NULL,expires_at_ms=NULL,state=NULL`;
          }
          break;
      }
      return status(applied);
    })
  );
});
