import { finishErasure } from "./settlement";
import { advanceLocalPurge } from "./local-purge";
import { directoryName } from "../../directory/contract";
import { pricingName } from "../../subscription/contract";
import { fenceLifetimeUrl, maintenanceName } from "../../maintenance/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import { ErasureHandoff, confirmHandoffUrl, participantFenceUrl } from "../contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";

const acknowledged = 204;

const conflictStatus = 409;

export const registerErasureCase = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">,
  storage: DurableObjectStorage
) {
  const handoff = yield* Schema.decodeUnknownEffect(ErasureHandoff, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;
  const exact = sql`SELECT 1 FROM erasure_cases WHERE reference=${handoff.reference} AND user_id=${handoff.userId} AND requested_at_ms=${handoff.requestedAtMs}`;

  if ((yield* exact).length === 1) return new Response(null, { status: acknowledged });
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff))(handoff);

  const confirmed = yield* Effect.tryPromise((signal) =>
    users.getByName(handoff.userId).fetch(confirmHandoffUrl, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  if (confirmed.status !== acknowledged) return new Response(null, { status: 409 });

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO erasure_cases(user_id,reference,requested_at_ms,state,next_check_ms) VALUES(${handoff.userId},${handoff.reference},${handoff.requestedAtMs},'Draining',${now}) ON CONFLICT DO NOTHING`;

      if ((yield* exact).length !== 1) return new Response(null, { status: 409 });
      yield* preserveStoreAlarm(storage, now);

      return new Response(null, { status: acknowledged });
    })
  );
});

export const repairCaseAlarm = Effect.fn(function* (storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;
  const [next] = yield* sql`SELECT next_check_ms FROM erasure_cases ORDER BY next_check_ms LIMIT 1`;

  return next === undefined
    ? false
    : yield* preserveStoreAlarm(
        storage,
        yield* Schema.decodeUnknownEffect(Schema.Int)(next.next_check_ms)
      );
});

const cooldownMs = 60_000;

const pageSize = 8;

const Case = Schema.Struct({
  ...ErasureHandoff.fields,
  state: Schema.Literals(["Draining", "Sealing", "Erasing", "ExternalPending", "Complete"]),
  directory_fenced: Schema.Literals([0, 1]),
  pricing_fenced: Schema.Literals([0, 1]),
  maintenance_fenced: Schema.Literals([0, 1]),
});

type Participants = Readonly<
  Record<"DIRECTORY" | "PRICING" | "MAINTENANCE", Pick<DurableObjectNamespace, "getByName">>
>;

type FenceParticipant = Readonly<{
  column: "directory_fenced" | "pricing_fenced" | "maintenance_fenced";
  owner: Pick<DurableObjectNamespace, "getByName">;
  name: string;
  url: string;
}>;

const fenceParticipant = Effect.fn(function* (
  record: typeof Case.Type,
  participant: FenceParticipant,
  body: string
) {
  const sql = yield* SqliteClient;
  const headers = { "fidy-user-id": record.userId, "fidy-erasure-reference": record.reference };

  const fenced = yield* Effect.tryPromise((signal) =>
    participant.owner
      .getByName(participant.name)
      .fetch(participant.url, { method: "POST", body, headers, signal })
  ).pipe(
    Effect.map((response) => response.status === acknowledged),
    Effect.timeout("5 seconds"),
    Effect.tapError(() =>
      Effect.logWarning({
        component: "erasure-store",
        operation: "fenceParticipant",
        outcome: "unfenced",
      })
    ),
    Effect.orElseSucceed(() => false)
  );

  if (fenced) {
    yield* sql`UPDATE erasure_cases SET ${sql(participant.column)}=1 WHERE reference=${record.reference} AND user_id=${record.userId}`;
  }
});

const fenceCase = Effect.fn(function* (record: typeof Case.Type, env: Participants) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff))(record);

  const participants = [
    {
      column: "directory_fenced",
      owner: env.DIRECTORY,
      name: directoryName,
      url: participantFenceUrl,
    },
    { column: "pricing_fenced", owner: env.PRICING, name: pricingName, url: participantFenceUrl },
    {
      column: "maintenance_fenced",
      owner: env.MAINTENANCE,
      name: maintenanceName,
      url: fenceLifetimeUrl,
    },
  ] as const;

  const unfenced = participants.filter((participant) => record[participant.column] !== 1);

  yield* Effect.forEach(unfenced, (participant) => fenceParticipant(record, participant, body), {
    discard: true,
  });
});

const advanceCase = Effect.fn(function* (
  record: typeof Case.Type,
  env: Participants & { USER_STORE: DurableObjectNamespace }
) {
  if (
    record.directory_fenced !== 1 ||
    record.pricing_fenced !== 1 ||
    record.maintenance_fenced !== 1
  ) {
    return yield* fenceCase(record, env);
  }

  if (record.state === "ExternalPending" || record.state === "Complete") {
    return yield* finishErasure(record, env);
  }

  yield* advanceLocalPurge(record, env);
});

export const advanceErasureCases = Effect.fn(function* (
  storage: DurableObjectStorage,
  env: Participants & { USER_STORE: DurableObjectNamespace }
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const page = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const due =
        yield* sql`UPDATE erasure_cases SET next_check_ms=${now + cooldownMs} WHERE reference IN (SELECT reference FROM erasure_cases WHERE next_check_ms<=${now} ORDER BY next_check_ms,reference LIMIT ${pageSize}) RETURNING user_id AS userId,reference,requested_at_ms AS requestedAtMs,state,directory_fenced,pricing_fenced,maintenance_fenced`;

      yield* repairCaseAlarm(storage);

      return yield* Schema.decodeUnknownEffect(Schema.Array(Case))(due);
    })
  );

  yield* Effect.forEach(
    page,
    (record) =>
      advanceCase(record, env).pipe(
        Effect.catch(() =>
          Effect.logWarning({
            component: "erasure-store",
            operation: "advanceCase",
            outcome: "deferred",
          })
        )
      ),
    {
      concurrency: 4,
      discard: true,
    }
  );
});

export const confirmLifetimeCase = Effect.fn(function* (request: Request) {
  const scope = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      userId: ErasureHandoff.fields.userId,
      reference: ErasureHandoff.fields.reference,
      action: Schema.Literals(["fence", "retire", "expire"]),
    })
  )(yield* Effect.tryPromise(() => request.json()));

  const sql = yield* SqliteClient;

  const present =
    yield* sql`SELECT 1 FROM erasure_cases WHERE reference=${scope.reference} AND user_id=${scope.userId} AND (${scope.action}='fence' OR (state='Complete' AND (${scope.action}='retire' OR (lifetime_retired=1 AND identity_released=1 AND protect_until_ms<=${yield* Clock.currentTimeMillis}))))`;

  return new Response(null, { status: present.length === 1 ? acknowledged : conflictStatus });
});
