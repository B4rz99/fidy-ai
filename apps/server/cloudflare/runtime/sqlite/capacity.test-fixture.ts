import { DurableObject } from "cloudflare:workers";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Schema } from "effect";
import { StoreCapacity } from "./contract";
import { createStoreRuntime, openSqliteStore, withStoreCapacity } from "./operations";

const owners = Schema.Literals(["user", "directory", "pricing", "maintenance", "erasure"]);

const limitBytes = 262144;

const rowBytes = 4000;

const warningAt = 0.7;

const restrictAt = 0.8;

const writes = new Map<string, { mode: "growth" | "required"; size: number }>([
  ["/ordinary", { mode: "growth", size: rowBytes }],
  ["/overflow", { mode: "growth", size: limitBytes }],
  ["/required", { mode: "required", size: rowBytes }],
  ["/full", { mode: "required", size: limitBytes }],
]);

export class CapacityProbe extends DurableObject<unknown> {
  private readonly runtime;
  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    const owner = Schema.decodeUnknownSync(owners)(state.id.name);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner,
      ceilingBytes: String(limitBytes),
    });
    state.waitUntil(
      state.blockConcurrencyWhile(() =>
        this.runtime.runPromise(
          openSqliteStore(
            {
              owner,
              steps: [
                {
                  version: 1,
                  id: "native-capacity-probe",
                  statements: [
                    "CREATE TABLE retained(id INTEGER PRIMARY KEY,kind TEXT,deadline INTEGER,payload BLOB) STRICT",
                    "INSERT INTO retained(id,kind,deadline) VALUES(1,'obligation',123456)",
                  ],
                },
              ],
            },
            "native-release"
          )
        )
      )
    );
  }
  override fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const sqlStorage = this.ctx.storage.sql;

    if (path === "/warn" || path === "/restrict") {
      const threshold = limitBytes * (path === "/warn" ? warningAt : restrictAt);

      while (sqlStorage.databaseSize < threshold) {
        sqlStorage.exec(
          "INSERT INTO retained(kind,payload) VALUES('fixture',zeroblob(?))",
          rowBytes
        );
      }
    }

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqliteClient;
        const capacity = yield* StoreCapacity;
        const write = writes.get(path);

        if (write !== undefined) {
          yield* Effect.gen(function* () {
            yield* sql`INSERT INTO retained(kind,deadline) VALUES ('accountability',123456)`;
            yield* sql`INSERT INTO retained(kind,payload) VALUES ('effect',zeroblob(${write.size}))`;
          }).pipe(withStoreCapacity(write.mode));
        }

        if (path === "/cleanup") {
          yield* sql`DELETE FROM retained WHERE kind='fixture'`.pipe(withStoreCapacity("required"));
        }

        const evidence = yield* capacity.observe;

        const [record] = yield* sql`SELECT
        sum(kind='accountability') AS accountability,
        sum(kind='effect') AS effects,
        sum(kind='fixture') AS padding,
        max(CASE WHEN id=1 THEN deadline END) AS originalDeadline FROM retained`;

        return Response.json({ ...evidence, ...record });
      }).pipe(
        Effect.tapCause(Effect.logDebug),
        Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
      )
    );
  }
}
