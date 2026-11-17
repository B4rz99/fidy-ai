import {
  createStoreRuntime,
  openSqliteStore,
  withStoreAdmission,
} from "../runtime/sqlite/operations";
import { DurableObject } from "cloudflare:workers";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  StoreCapacity,
  type StoreHistory,
  type StoreReleaseEnvironment,
} from "../runtime/sqlite/contract";
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

const initialDirectorySchema = [
  `CREATE TABLE session_routes (
          token_digest BLOB PRIMARY KEY CHECK(length(token_digest)=32),
          user_id TEXT NOT NULL, session_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
          hard_expires_at_ms INTEGER NOT NULL) STRICT`,
];

const directoryHistory: StoreHistory = {
  owner: "directory",
  steps: [
    { version: 1, id: "initial-session-routes", statements: initialDirectorySchema },
    {
      version: 2,
      id: "pat-routes",
      statements: [
        `CREATE TABLE pat_routes(short_id TEXT PRIMARY KEY CHECK(length(short_id)=8),user_id TEXT NOT NULL,pat_id TEXT NOT NULL,reservation_id TEXT NOT NULL,expires_at_ms INTEGER NOT NULL) STRICT`,
        `CREATE TABLE unresolved_source_buckets(subject TEXT PRIMARY KEY NOT NULL,virtual_at_ms INTEGER NOT NULL) STRICT`,
        `CREATE INDEX unresolved_source_expiry ON unresolved_source_buckets(virtual_at_ms)`,
      ],
    },
  ],
};

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
  override fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      ![sessionRouteUrl, patRouteUrl, sourcePressureUrl].includes(request.url) ||
      !this.ctx.id.equals(this.env.DIRECTORY.idFromName(directoryName))
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
