import { ownerCheckRequest, ownerCheckResponse } from "../maintenance/contract";
import {
  createStoreRuntime,
  openSqliteStore,
  preserveStoreAlarm,
  storeReadiness,
  withStoreAdmission,
  withStoreCapacity,
} from "../runtime/sqlite/operations";
import {
  StoreCapacity,
  type StoreReleaseEnvironment,
  storeReadinessUrl,
} from "../runtime/sqlite/contract";

import { DurableObject } from "cloudflare:workers";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";

import { directoryHistory } from "./schema/operations";
import { Clock, Effect, Schema } from "effect";
import { TokenShortId } from "../../src/core/tokens/contract";
import { canonicalRequestProtection } from "../canonical-admission/contract";
import {
  PATRoute,
  SessionRoute,
  directoryName,
  patRouteUrl,
  sessionRouteUrl,
  sourcePressureUrl,
} from "./contract";

type DirectoryEnvironment = StoreReleaseEnvironment &
  Readonly<{ DIRECTORY: DurableObjectNamespace }>;

const digestBytes = 32;
const sourceExpiryPageSize = 32;
const admittedStatus = 204;
const pressureStatus = 429;

const admitUnresolved = Effect.fn(function* (source: string) {
  const sql = yield* SqliteClient;
  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      const { intervalMs, burst } = canonicalRequestProtection;
      yield* sql`DELETE FROM unresolved_source_buckets WHERE subject IN (SELECT subject FROM unresolved_source_buckets WHERE virtual_at_ms<=${current} ORDER BY virtual_at_ms LIMIT ${sourceExpiryPageSize})`;
      const retained = yield* sql`SELECT 1 FROM unresolved_source_buckets WHERE subject=${source}`;
      if (retained.length === 0) yield* admitGrowth;
      const rows = yield* sql`INSERT INTO unresolved_source_buckets(subject,virtual_at_ms)
            VALUES (${source},${current + intervalMs}) ON CONFLICT(subject) DO UPDATE
            SET virtual_at_ms=max(virtual_at_ms,${current})+${intervalMs}
            WHERE virtual_at_ms<=${current + (burst - 1) * intervalMs} RETURNING subject`;
      return new Response(null, {
        status: rows.length === 1 ? admittedStatus : pressureStatus,
      });
    })
  );
});

/** Pressure buckets use the original virtual time. Only the owner alarm drains a bounded expired page. */
const inspectPressure = Effect.fnUntraced(function* (
  storage: DurableObjectStorage,
  drain: boolean
) {
  const sql = yield* SqliteClient;
  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (drain) {
        yield* sql`DELETE FROM unresolved_source_buckets WHERE subject IN (SELECT subject FROM unresolved_source_buckets WHERE virtual_at_ms<=${now} ORDER BY virtual_at_ms LIMIT ${sourceExpiryPageSize})`;
      }
      const [row] =
        yield* sql`SELECT virtual_at_ms FROM unresolved_source_buckets ORDER BY virtual_at_ms LIMIT 1`;
      if (row === undefined) return false;
      const next = yield* Schema.decodeUnknownEffect(Schema.Struct({ virtual_at_ms: Schema.Int }))(
        row
      );
      return yield* preserveStoreAlarm(storage, Math.max(next.virtual_at_ms, now));
    })
  );
});

export class Directory extends DurableObject<DirectoryEnvironment> {
  private readonly runtime;
  constructor(state: DurableObjectState, env: DirectoryEnvironment) {
    super(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: "directory",
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
    state.waitUntil(
      state.blockConcurrencyWhile(() =>
        this.runtime.runPromise(openSqliteStore(directoryHistory, env.CF_VERSION_METADATA.id))
      )
    );
  }
  override alarm(): Promise<void> {
    return this.runtime.runPromise(inspectPressure(this.ctx.storage, true).pipe(Effect.asVoid));
  }
  override fetch(request: Request): Promise<Response> {
    if (!this.ctx.id.equals(this.env.DIRECTORY.idFromName(directoryName))) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (ownerCheckRequest(request)) {
      return this.runtime.runPromise(
        inspectPressure(this.ctx.storage, false).pipe(Effect.map(ownerCheckResponse))
      );
    }
    if (request.method === "GET" && request.url === storeReadinessUrl) {
      return this.runtime.runPromise(
        storeReadiness({ history: directoryHistory, release: this.env.CF_VERSION_METADATA.id })
      );
    }
    if (
      request.method !== "POST" ||
      ![sessionRouteUrl, patRouteUrl, sourcePressureUrl].includes(request.url)
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return this.runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* StoreCapacity).observe;
        const sql = yield* SqliteClient;
        if (request.url === sourcePressureUrl) {
          const source = yield* Effect.tryPromise(() => request.text());
          if (!/^[0-9a-f]{64}$/u.test(source)) return new Response(null, { status: 400 });
          return yield* admitUnresolved(source);
        }
        if (request.url === patRouteUrl) {
          const shortId = yield* Schema.decodeEffect(TokenShortId)(
            yield* Effect.tryPromise(() => request.text())
          );
          const current = yield* Clock.currentTimeMillis;
          const [row] =
            yield* sql`SELECT user_id AS userId,pat_id AS patId FROM pat_routes WHERE short_id=${shortId} AND expires_at_ms>${current}`;
          return row === undefined
            ? new Response(null, { status: 404 })
            : Response.json(yield* Schema.decodeUnknownEffect(PATRoute)(row));
        }
        const digest = new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer()));
        if (digest.byteLength !== digestBytes) return new Response(null, { status: 400 });
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* Clock.currentTimeMillis;
            const rows =
              yield* sql`SELECT user_id AS userId,session_id AS sessionId FROM session_routes
          WHERE token_digest=${digest} AND hard_expires_at_ms>${current}`;
            if (rows.length === 0) return new Response(null, { status: 404 });
            return Response.json(yield* Schema.decodeUnknownEffect(SessionRoute)(rows[0]));
          })
        );
      }).pipe(Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 }))))
    );
  }
}
