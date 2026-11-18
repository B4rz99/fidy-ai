import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { EmailCapacitySlot } from "../../directory/contract";
import { sendEmailCapacity } from "../../directory/operations";
import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";

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
const lookup = Effect.fn(function* (id: string) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql`SELECT * FROM forwarded_email_receipts WHERE id=${id}`;
  return row === undefined
    ? Option.none()
    : Option.some(yield* Schema.decodeUnknownEffect(CurrentSlot)(row));
});
const discardStoring = Effect.fn(function* (id: string, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`UPDATE forwarded_email_receipts SET state='discarding' WHERE id=${id} AND state='storing' AND capacity_claimed=0`;
      yield* preserveStoreAlarm(storage, yield* Clock.currentTimeMillis);
    })
  );
});
const chooseSlot = Effect.fn(function* (
  directory: DurableObjectNamespace,
  row: typeof CurrentSlot.Type
) {
  if (row.capacity_slot !== null && row.capacity_generation !== null) {
    return { slot: row.capacity_slot, generation: row.capacity_generation };
  }
  const offered = yield* sendEmailCapacity(directory, { _tag: "Offer" });
  if (offered.status === full) return "full" as const;
  if (!offered.ok) return yield* unavailable();
  const offer = yield* Schema.decodeUnknownEffect(EmailCapacitySlot)(
    yield* Effect.tryPromise(() => offered.json())
  );
  const sql = yield* SqliteClient;
  const saved = yield* withStoreCapacity("required")(
    sql`UPDATE forwarded_email_receipts SET capacity_slot=${offer.slot},capacity_generation=${offer.generation} WHERE id=${row.id} AND state='storing' AND capacity_slot IS NULL RETURNING id`
  );
  return saved.length === 1 ? offer : ("retry" as const);
});
const applyClaim = Effect.fn(function* (
  directory: DurableObjectNamespace,
  storage: DurableObjectStorage,
  {
    id,
    slot,
    generation,
    expires,
  }: { id: string; slot: number; generation: number; expires: number }
) {
  const sql = yield* SqliteClient;
  const claimed = yield* sendEmailCapacity(directory, {
    _tag: "Claim",
    slot,
    generation,
    receipt: id,
    expires,
  });
  if (claimed.status === full) {
    yield* discardStoring(id, storage);
    return false;
  }
  if (claimed.status === stale) {
    yield* withStoreCapacity("required")(
      sql`UPDATE forwarded_email_receipts SET capacity_slot=NULL,capacity_generation=NULL WHERE id=${id} AND state='storing' AND capacity_slot=${slot} AND capacity_generation=${generation} AND capacity_claimed=0`
    );
    return "retry" as const;
  }
  if (claimed.status !== applied) return yield* unavailable();
  const saved = yield* withStoreCapacity("required")(
    sql`UPDATE forwarded_email_receipts SET capacity_claimed=1 WHERE id=${id} AND state='storing' AND capacity_slot=${slot} AND capacity_generation=${generation} RETURNING id`
  );
  return saved.length === 1;
});
/** Persist the offered generation before claiming it. Lost replies can retry or fence only that generation. */
export const claimEmailCapacity = Effect.fn(function* (
  directory: DurableObjectNamespace,
  id: string,
  storage: DurableObjectStorage
) {
  const maxOffers = 4;
  for (let attempt = 0; attempt < maxOffers; attempt++) {
    const selected = yield* lookup(id);
    if (Option.isNone(selected) || selected.value.state !== "storing") return false;
    const row = selected.value;
    if (row.capacity_claimed === 1) return true;
    const offer = yield* chooseSlot(directory, row);
    if (offer === "retry") continue;
    if (offer === "full") {
      yield* discardStoring(id, storage);
      return false;
    }
    const { slot, generation } = offer;
    const result = yield* applyClaim(directory, storage, {
      id,
      slot,
      generation,
      expires: row.expires_at_ms,
    });
    if (result !== "retry") return result;
  }
  return yield* unavailable();
});
/** Release also fences an unacknowledged claim that arrives after disposal or erasure. */
export const updateSharedEmailCapacity = Effect.fn(function* (
  directory: DurableObjectNamespace,
  id: string,
  action: "Release" | "Settle"
) {
  const selected = yield* lookup(id);
  if (Option.isNone(selected)) return;
  const {
    capacity_slot: slot,
    capacity_generation: generation,
    expires_at_ms: expires,
  } = selected.value;
  if (slot === null || generation === null) return;
  const result = yield* sendEmailCapacity(directory, {
    _tag: action,
    slot,
    generation,
    receipt: id,
    expires,
  });
  if (result.status !== applied) return yield* unavailable();
});

export const settleSharedEmailCapacity = Effect.fn(function* (
  directory: DurableObjectNamespace,
  id: string
) {
  yield* updateSharedEmailCapacity(directory, id, "Settle");
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    sql`UPDATE forwarded_email_receipts SET capacity_settled=1 WHERE id=${id} AND outcome IS NOT NULL`
  );
});
