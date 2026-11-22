import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import { ProviderSpend, providerAllowanceUrl } from "../contract";
import { type ExternalEventNamespace, directoryName } from "../../directory/contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";

const acceptedStatus = 204,
  limitedStatus = 429;

const day = 86_400_000;

const limits = {
  model: { user: { count: 500, units: 32_000_000 }, shared: { count: 50_000, units: 512_000_000 } },
  reminderGeneration: {
    user: { count: 32, units: 32 },
    shared: { count: 100_000, units: 100_000 },
  },
  reminderSend: {
    user: { count: 32, units: 131072 },
    shared: { count: 10_000, units: 40_960_000 },
  },
} as const;

export const chargeProvider = Effect.fn(function* (
  input: typeof ProviderSpend.Type,
  scope: "user" | "shared",
  current: number
) {
  const sql = yield* SqliteClient;
  const limit = limits[input.phase][scope];
  const cutoff = current - day;
  yield* sql`DELETE FROM provider_spend_attempts WHERE rowid IN (SELECT rowid FROM provider_spend_attempts WHERE at_ms<=${cutoff} ORDER BY at_ms LIMIT 128)`;

  const [held] =
    yield* sql`SELECT COUNT(*) AS attempts,coalesce(SUM(units),0) AS units FROM provider_spend_attempts WHERE phase=${input.phase} AND at_ms>${cutoff}`;

  const seen = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ attempts: Schema.Int, units: Schema.Int })
  )(held);

  if (seen.attempts >= limit.count) return false;
  const eligible = seen.units + input.units <= limit.units;
  yield* sql`INSERT INTO provider_spend_attempts(phase,at_ms,units) VALUES(${input.phase},${current},${eligible ? input.units : 0})`;

  return eligible;
});

export const sharedProviderRequest = Effect.fn(function* (request: Request) {
  const work = yield* Schema.decodeUnknownEffect(ProviderSpend)(
    yield* Effect.tryPromise(() => request.json())
  );

  const allowed = yield* chargeProvider(work, "shared", yield* Clock.currentTimeMillis).pipe(
    withStoreCapacity("growth")
  );

  return new Response(null, { status: allowed ? acceptedStatus : limitedStatus });
});

export const reserveSharedProvider = Effect.fn(function* (
  directory: ExternalEventNamespace,
  work: typeof ProviderSpend.Type
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ProviderSpend))(work);

  const response = yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(providerAllowanceUrl, { method: "POST", body, signal })
  );

  return response.ok;
});
