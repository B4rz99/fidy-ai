import { Clock, Data, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  type EmailCapacityCommand,
  EmailCapacitySlot,
  type IngestionCapacity,
} from "../../directory/contract";
import { sendIngestionCapacity } from "../../directory/operations";
import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";

const capacityCommand = Data.taggedEnum<typeof EmailCapacityCommand.Type>();

const stale = 409,
  full = 429,
  applied = 204;

const unavailable = (): CanonicalAdmissionUnavailable =>
  new CanonicalAdmissionUnavailable({ cause: "email_capacity" });

const CurrentSlot = Schema.Struct({
  id: Schema.String,
  expires_at_ms: Schema.Int,
  capacity_slot: Schema.NullOr(Schema.Int),
  capacity_generation: Schema.NullOr(Schema.Int),
  capacity_claimed: Schema.Int,
  state: Schema.String,
});

const receipts = { email: "forwarded_email_receipts", media: "media_capacity_receipts" };

const lookup = Effect.fn(function* (id: string, purpose: IngestionCapacity) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql`SELECT * FROM ${sql(receipts[purpose])} WHERE id=${id}`;

  return row === undefined
    ? Option.none()
    : Option.some(yield* Schema.decodeUnknownEffect(CurrentSlot)(row));
});

const discardStoring = Effect.fn(function* (
  id: string,
  storage: DurableObjectStorage,
  purpose: IngestionCapacity
) {
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`UPDATE ${sql(receipts[purpose])} SET state='discarding' WHERE id=${id} AND state='storing' AND capacity_claimed=0`;
      yield* preserveStoreAlarm(storage, yield* Clock.currentTimeMillis);
    })
  );
});

const chooseSlot = Effect.fn(function* (
  directory: DurableObjectNamespace,
  row: typeof CurrentSlot.Type,
  purpose: IngestionCapacity
) {
  if (row.capacity_slot !== null && row.capacity_generation !== null) {
    return { slot: row.capacity_slot, generation: row.capacity_generation };
  }

  const offered = yield* sendIngestionCapacity(directory, capacityCommand.Offer(), purpose);

  if (offered.status === full) return "full" as const;

  if (!offered.ok) return yield* unavailable();

  const offer = yield* Schema.decodeUnknownEffect(EmailCapacitySlot)(
    yield* Effect.tryPromise(() => offered.json())
  );

  const sql = yield* SqliteClient;

  const saved = yield* withStoreCapacity("required")(
    sql`UPDATE ${sql(receipts[purpose])} SET capacity_slot=${offer.slot},capacity_generation=${offer.generation} WHERE id=${row.id} AND state='storing' AND capacity_slot IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests) RETURNING id`
  );

  return saved.length === 1 ? offer : ("retry" as const);
});

type CapacityTarget = { directory: DurableObjectNamespace; purpose: IngestionCapacity };

const applyClaim = Effect.fn(function* (
  { directory, purpose }: CapacityTarget,
  storage: DurableObjectStorage,
  {
    id,
    slot,
    generation,
    expires,
  }: { id: string; slot: number; generation: number; expires: number }
) {
  const sql = yield* SqliteClient;

  const claimed = yield* sendIngestionCapacity(
    directory,
    capacityCommand.Claim({ slot, generation, receipt: id, expires }),
    purpose
  );

  if (claimed.status === full) {
    yield* discardStoring(id, storage, purpose);

    return false;
  }

  if (claimed.status === stale) {
    yield* withStoreCapacity("required")(
      sql`UPDATE ${sql(receipts[purpose])} SET capacity_slot=NULL,capacity_generation=NULL WHERE id=${id} AND state='storing' AND capacity_slot=${slot} AND capacity_generation=${generation} AND capacity_claimed=0`
    );

    return "retry" as const;
  }

  if (claimed.status !== applied) return yield* unavailable();

  const saved = yield* withStoreCapacity("required")(
    sql`UPDATE ${sql(receipts[purpose])} SET capacity_claimed=1 WHERE id=${id} AND state='storing' AND capacity_slot=${slot} AND capacity_generation=${generation} RETURNING id`
  );

  return saved.length === 1;
});

const offerClaim = Effect.fn(function* (
  { directory, purpose }: CapacityTarget,
  id: string,
  storage: DurableObjectStorage
) {
  const selected = yield* lookup(id, purpose);

  if (Option.isNone(selected) || selected.value.state !== "storing") return Option.some(false);
  const row = selected.value;

  if (row.capacity_claimed === 1) return Option.some(true);
  const offer = yield* chooseSlot(directory, row, purpose);

  if (offer === "retry") return Option.none<boolean>();

  if (offer === "full") {
    yield* discardStoring(id, storage, purpose);

    return Option.some(false);
  }

  const { slot, generation } = offer;

  const result = yield* applyClaim({ directory, purpose }, storage, {
    id,
    slot,
    generation,
    expires: row.expires_at_ms,
  });

  return result === "retry" ? Option.none<boolean>() : Option.some(result);
});

export const claimIngestionCapacity = Effect.fn(function* (
  target: CapacityTarget,
  id: string,
  storage: DurableObjectStorage
) {
  const maxOffers = 4;

  const claimed = yield* offerClaim(target, id, storage).pipe(
    Effect.repeat({ while: Option.isNone, times: maxOffers - 1 })
  );

  if (Option.isNone(claimed)) return yield* unavailable();

  return claimed.value;
});

export const updateSharedCapacity = Effect.fn(function* (
  { directory, purpose }: CapacityTarget,
  id: string,
  action: "Release" | "Settle"
) {
  const selected = yield* lookup(id, purpose);

  if (Option.isNone(selected)) return;

  const {
    capacity_slot: slot,
    capacity_generation: generation,
    expires_at_ms: expires,
  } = selected.value;

  if (slot === null || generation === null) return;

  const result = yield* sendIngestionCapacity(
    directory,
    capacityCommand[action]({ slot, generation, receipt: id, expires }),
    purpose
  );

  if (result.status !== applied) return yield* unavailable();
});

export const settleSharedEmailCapacity = Effect.fn(function* (
  directory: DurableObjectNamespace,
  id: string
) {
  yield* updateSharedCapacity({ directory, purpose: "email" }, id, "Settle");
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    sql`UPDATE forwarded_email_receipts SET capacity_settled=1 WHERE id=${id} AND outcome IS NOT NULL`
  );
});
