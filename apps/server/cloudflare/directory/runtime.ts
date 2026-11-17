import { createStoreRuntime, openSqliteStore } from "../runtime/sqlite/operations";
import { DurableObject } from "cloudflare:workers";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  StoreCapacity,
  type StoreHistory,
  type StoreReleaseEnvironment,
} from "../runtime/sqlite/contract";
import { Clock, Effect, Schema } from "effect";
import { SessionRoute, directoryName, sessionRouteUrl } from "./contract";

type DirectoryEnvironment = StoreReleaseEnvironment &
  Readonly<{ DIRECTORY: DurableObjectNamespace }>;

const digestBytes = 32;

const initialDirectorySchema = [
  `CREATE TABLE session_routes (
          token_digest BLOB PRIMARY KEY CHECK(length(token_digest)=32),
          user_id TEXT NOT NULL, session_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
          hard_expires_at_ms INTEGER NOT NULL) STRICT`,
];

const directoryHistory: StoreHistory = {
  owner: "directory",
  steps: [{ version: 1, id: "initial-session-routes", statements: initialDirectorySchema }],
};

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
      request.url !== sessionRouteUrl ||
      !this.ctx.id.equals(this.env.DIRECTORY.idFromName(directoryName))
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return this.runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* StoreCapacity).observe;
        const digest = new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer()));
        if (digest.byteLength !== digestBytes) return new Response(null, { status: 400 });
        const sql = yield* SqliteClient;
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
