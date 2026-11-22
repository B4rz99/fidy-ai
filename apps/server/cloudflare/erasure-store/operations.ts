import { type ErasureRegistryNamespace, erasureRegistryName } from "../erasure/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { preserveStoreAlarm, withStoreCapacity } from "../runtime/sqlite/operations";
import type { StoreHistory } from "../runtime/sqlite/contract";
import { Clock, Effect, Schema } from "effect";
import {
  CleanupCommand,
  CleanupPermission,
  CleanupProgress,
  ErasureHandoff,
  confirmCleanupUrl,
  confirmHandoffUrl,
} from "./contract";

export const erasureStoreHistory: StoreHistory = {
  owner: "erasure",
  steps: [
    { version: 1, id: "initial-erasure-store", statements: [] },
    {
      version: 2,
      id: "independent-erasure-cases",
      statements: [
        "CREATE TABLE erasure_cases(user_id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,requested_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('Draining','Sealing','Erasing','ExternalPending','Complete')),next_check_ms INTEGER NOT NULL,directory_fenced INTEGER NOT NULL DEFAULT 0 CHECK(directory_fenced IN(0,1)),pricing_fenced INTEGER NOT NULL DEFAULT 0 CHECK(pricing_fenced IN(0,1)),maintenance_fenced INTEGER NOT NULL DEFAULT 0 CHECK(maintenance_fenced IN(0,1))) STRICT",
        "CREATE INDEX erasure_case_wake ON erasure_cases(next_check_ms)",
      ],
    },
    {
      version: 3,
      id: "sealed-user-purge",
      statements: [
        "ALTER TABLE erasure_cases ADD COLUMN shared_drained INTEGER NOT NULL DEFAULT 0 CHECK(shared_drained IN(0,1))",
        "ALTER TABLE erasure_cases ADD COLUMN drained_at_ms INTEGER",
        "ALTER TABLE erasure_cases ADD COLUMN last_erased_at_ms INTEGER",
        "ALTER TABLE erasure_cases ADD COLUMN connection_blocked INTEGER NOT NULL DEFAULT 0 CHECK(connection_blocked IN(0,1))",
        "CREATE TABLE erasure_resend_scope(reference TEXT NOT NULL REFERENCES erasure_cases(reference) ON DELETE CASCADE,work_id TEXT NOT NULL,requested_at_ms INTEGER NOT NULL,PRIMARY KEY(reference,work_id)) STRICT",
        "CREATE TABLE erasure_case_custodians(reference TEXT NOT NULL REFERENCES erasure_cases(reference) ON DELETE CASCADE,custodian TEXT NOT NULL CHECK(custodian IN('Cloudflare','Kapso','Meta','Resend','Wompi')),observed_use INTEGER NOT NULL CHECK(observed_use IN(0,1)),status TEXT NOT NULL CHECK(status IN('Pending','Unresolved','Accepted','Verified','NotApplicable')),PRIMARY KEY(reference,custodian)) STRICT",
        "CREATE TRIGGER release_resend_scope AFTER UPDATE OF status ON erasure_case_custodians WHEN NEW.custodian='Resend' AND NEW.status='Verified' BEGIN DELETE FROM erasure_resend_scope WHERE reference=NEW.reference; END",
      ],
    },
    {
      version: 4,
      id: "case-custody-and-retirement",
      statements: [
        ...[
          "directory_clean",
          "pricing_clean",
          "identity_released",
          "lifetime_retired",
          "directory_expired",
          "pricing_expired",
          "maintenance_expired",
        ].map(
          (column) =>
            `ALTER TABLE erasure_cases ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK(${column} IN(0,1))`
        ),
        "ALTER TABLE erasure_cases ADD COLUMN protect_until_ms INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE erasure_case_custodians ADD COLUMN event_id TEXT",
        "CREATE TABLE erasure_case_evidence(id TEXT PRIMARY KEY,reference TEXT NOT NULL,custodian TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,operator_ref TEXT NOT NULL,recorded_at_ms INTEGER NOT NULL,FOREIGN KEY(reference,custodian) REFERENCES erasure_case_custodians(reference,custodian) ON DELETE CASCADE,UNIQUE(reference,custodian,status,reason)) STRICT",
      ],
    },
  ],
};

export const participantDrain = Effect.fn(function* (
  request: Request,
  outstanding: (userId: string) => OwnedStatement
) {
  const scope = yield* Schema.decodeUnknownEffect(ErasureHandoff, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;
  const check = outstanding(scope.userId);
  const pending = sql.unsafe(check.sql, check.params);

  const reply =
    yield* sql`SELECT 1 FROM erasure_barriers WHERE user_id=${scope.userId} AND reference=${scope.reference} AND requested_at_ms=${scope.requestedAtMs} AND NOT (${pending})`;

  return new Response(null, { status: reply.length === 1 ? acknowledged : conflictStatus });
});

export const erasureBarrierSchema =
  "CREATE TABLE erasure_barriers(user_id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,requested_at_ms INTEGER NOT NULL) STRICT";

const acknowledged = 204;

const conflictStatus = 409;

export const fenceErasureParticipant = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">,
  storage: DurableObjectStorage
) {
  const handoff = yield* Schema.decodeUnknownEffect(ErasureHandoff, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;
  const exact = sql`SELECT 1 FROM erasure_barriers WHERE user_id=${handoff.userId} AND reference=${handoff.reference} AND requested_at_ms=${handoff.requestedAtMs}`;

  if ((yield* exact).length === 1) return new Response(null, { status: acknowledged });
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff))(handoff);

  const confirmed = yield* Effect.tryPromise((signal) =>
    users.getByName(handoff.userId).fetch(confirmHandoffUrl, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  if (confirmed.status !== acknowledged) return new Response(null, { status: conflictStatus });

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`INSERT INTO erasure_barriers(user_id,reference,requested_at_ms) VALUES(${handoff.userId},${handoff.reference},${handoff.requestedAtMs}) ON CONFLICT DO NOTHING`;
      yield* preserveStoreAlarm(storage, yield* Clock.currentTimeMillis);

      return new Response(null, {
        status: (yield* exact).length === 1 ? acknowledged : conflictStatus,
      });
    })
  );
});

export const cleanupBarrierColumns = [
  "ALTER TABLE erasure_barriers ADD COLUMN last_erased_at_ms INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE erasure_barriers ADD COLUMN protect_until_ms INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE erasure_barriers ADD COLUMN cleaned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE erasure_barriers ADD COLUMN released INTEGER NOT NULL DEFAULT 0",
  "CREATE INDEX erasure_active_cleanup ON erasure_barriers(user_id) WHERE cleaned=0",
];

export const deletionWitness = ({
  table,
  deadline,
  owner,
}: Readonly<{ table: string; deadline: string; owner: string }>): string =>
  `CREATE TRIGGER erasure_removed_${table} AFTER DELETE ON ${table} WHEN EXISTS(SELECT 1 FROM erasure_barriers WHERE cleaned=0) BEGIN UPDATE erasure_barriers SET last_erased_at_ms=max(last_erased_at_ms,CAST(round(unixepoch('subsec')*1000) AS INTEGER)),protect_until_ms=max(protect_until_ms,coalesce(${deadline},0)) WHERE user_id=${owner} AND cleaned=0; END`;

type CleanupOwner<R, E> = (
  scope: typeof CleanupCommand.Type,
  permission: typeof CleanupPermission.Type
) => Effect.Effect<boolean, E, R>;

const refused = (): Response => new Response(null, { status: 409 });

const expireBarrier = Effect.fn(function* (scope: typeof CleanupCommand.Type) {
  const sql = yield* SqliteClient;
  yield* sql`DELETE FROM erasure_barriers WHERE user_id=${scope.userId} AND reference=${scope.reference} AND requested_at_ms=${scope.requestedAtMs} AND cleaned=1`;

  const conflict =
    yield* sql`SELECT 1 FROM erasure_barriers WHERE user_id=${scope.userId} OR reference=${scope.reference}`;

  return new Response(null, { status: conflict.length === 0 ? acknowledged : conflictStatus });
});

export const handleSharedCleanup = Effect.fn(function* <R, E>(
  request: Request,
  registry: ErasureRegistryNamespace,
  clean: CleanupOwner<R, E>
) {
  const scope = yield* Schema.decodeUnknownEffect(CleanupCommand, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => request.json())
  );

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(CleanupCommand))(scope);

  const permission = yield* Effect.tryPromise((signal) =>
    registry
      .getByName(erasureRegistryName)
      .fetch(confirmCleanupUrl, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  if (!permission.ok) return refused();

  const grants = yield* Schema.decodeUnknownEffect(CleanupPermission)(
    yield* Effect.tryPromise(() => permission.json())
  );

  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const exact = sql`user_id=${scope.userId} AND reference=${scope.reference} AND requested_at_ms=${scope.requestedAtMs}`;
      const [row] = yield* sql`SELECT cleaned,released FROM erasure_barriers WHERE ${exact}`;

      if (scope.action === "expire") return yield* expireBarrier(scope);

      if (row === undefined) return refused();

      if (scope.action === "release") {
        if (row.cleaned !== 1) return refused();

        if (row.released === 1) return new Response(null, { status: 204 });

        if (!(yield* clean(scope, grants))) return new Response(null, { status: 202 });
        yield* sql`UPDATE erasure_barriers SET released=1 WHERE ${exact}`;

        return new Response(null, { status: 204 });
      }

      if (row.cleaned !== 1) {
        const done = yield* clean(scope, grants);
        yield* sql`UPDATE erasure_barriers SET cleaned=${Number(done)} WHERE ${exact}`;
      }

      const [progress] = yield* Schema.decodeUnknownEffect(Schema.Tuple([CleanupProgress]))(
        (yield* sql`SELECT cleaned AS done,last_erased_at_ms AS lastErasedAtMs,protect_until_ms AS protectUntilMs FROM erasure_barriers WHERE ${exact}`).map(
          (row) => ({ ...row, done: row.done === 1 })
        )
      );

      return Response.json(progress);
    })
  );
});
