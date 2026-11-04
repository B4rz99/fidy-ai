import type { AuthoritativeStoreEnvironment, SqliteStoreBinding } from "./contract";
import { Effect, Schema } from "effect";
import { AuthoritativeSqliteStore } from "./runtime";
import { makeRemoteSqliteDatabase, makeSqliteDatabase, withAuthoritativeStore } from "./operations";

const installProduction = (db: D1Database, request: Request): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => request.json());
      const statements = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(input);
      yield* Effect.tryPromise(() =>
        db.batch(statements.map((statement) => db.prepare(statement)))
      );
      const user = "10000000-0000-4000-8000-000000000001";
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(user),
          db
            .prepare(
              "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('t',?,'1.00','COP','outflow',(SELECT id FROM categories LIMIT 1),0,0)"
            )
            .bind(user),
        ])
      );
      const rejected = yield* Effect.tryPromise(() =>
        db.prepare("DELETE FROM users WHERE id=?").bind(user).run()
      ).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
      const facts = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT amount FROM transaction_effective_source WHERE user_id=?")
          .bind(user)
          .all()
      );
      return Response.json({ rejected, facts: facts.results });
    }).pipe(Effect.catch((error) => Effect.succeed(new Response(String(error), { status: 500 }))))
  );

const binaryRowId = 7;
const highestByte = 255;
const payloadMarker = 42;
const bindingsProof = (db: D1Database): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("CREATE TABLE bytes(id INTEGER PRIMARY KEY,payload BLOB NOT NULL)"),
          db.prepare("CREATE TABLE receipts(id INTEGER)"),
          db.prepare(
            "CREATE TRIGGER bytes_receipt AFTER INSERT ON bytes BEGIN INSERT INTO receipts VALUES(new.id); END"
          ),
        ])
      );
      const inserted = yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO bytes VALUES(?,?)")
          .bind(binaryRowId, new Uint8Array([0, highestByte, payloadMarker]))
          .run()
      );
      const guarded = yield* Effect.tryPromise(() =>
        db.prepare("SELECT changes() AS count").first<number>("count")
      );
      const raw = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id,payload FROM bytes").raw({ columnNames: true })
      );
      const row = yield* Effect.tryPromise(() => db.prepare("SELECT payload FROM bytes").first());
      const missing = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM bytes WHERE id=99").first()
      );
      return Response.json({ changes: inserted.meta.changes, guarded, raw, row, missing });
    })
  );

export class AdapterProof {
  private readonly storage: DurableObjectStorage;
  constructor(state: DurableObjectState) {
    this.storage = state.storage;
  }
  fetch(request: Request): Promise<Response> {
    const db = makeSqliteDatabase(this.storage);
    if (new URL(request.url).pathname === "/schema") return installProduction(db, request);
    if (new URL(request.url).pathname === "/bindings") return bindingsProof(db);
    if (new URL(request.url).pathname === "/exec") {
      return Effect.runPromise(
        Effect.gen(function* () {
          const executed = yield* Effect.tryPromise(() =>
            db.exec(
              "CREATE TABLE execution_receipts(value TEXT)\nINSERT INTO execution_receipts VALUES('retained')"
            )
          );
          const value = yield* Effect.tryPromise(() =>
            db.prepare("SELECT value FROM execution_receipts").first("value")
          );
          return Response.json({ executed, value });
        })
      );
    }
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)"
            )
            .run()
        );
        yield* Effect.tryPromise(() => db.prepare("INSERT INTO items VALUES(1,'first')").run());
        const before = yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) FROM items").first<number>("count(*)")
        );
        const changed = yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("UPDATE items SET value='changed' WHERE id=1"),
            db.prepare("SELECT changes() AS changed"),
          ])
        );
        const failed = yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("INSERT INTO items VALUES(2,'second')"),
            db.prepare("INSERT INTO items VALUES(3,'changed')"),
          ])
        ).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
        const after = yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) FROM items").first<number>("count(*)")
        );
        return Response.json({ before, after, changes: changed[0]?.meta.changes, failed });
      })
    );
  }
}
export class ActiveStoreProof extends AuthoritativeSqliteStore {
  constructor(state: DurableObjectState, env: { SQLITE_STORE_MANIFEST: string }) {
    super(state, env);
    // Test-only bootstrap: production serving code exposes no sealing or import RPC.
    state.storage.kv.put("store-seal", {
      manifest: "fixture",
      epoch: "fixture",
      status: "verified",
    });
    if (state.storage.kv.get("store-admission") === undefined) {
      state.storage.kv.put("store-admission", { phase: "Open", epoch: "fixture" });
    }
  }
}
export { AuthoritativeSqliteStore };
const targetProof = (configuration: AuthoritativeStoreEnvironment): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const selected = yield* Effect.try(() => withAuthoritativeStore(configuration));
      const { DB: db } = withAuthoritativeStore(selected);
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("CREATE TABLE target_receipts(value TEXT)"),
          db.prepare("INSERT INTO target_receipts VALUES('one-target')"),
        ])
      );
      const value = yield* Effect.tryPromise(() =>
        db.prepare("SELECT value FROM target_receipts").first("value")
      );
      return Response.json({ value });
    }).pipe(Effect.orElseSucceed(() => new Response(null, { status: 503 })))
  );

type AdapterEnvironment = {
  DB: D1Database;
  PROOF: DurableObjectNamespace;
  STORE: DurableObjectNamespace<ActiveStoreProof>;
  INACTIVE: DurableObjectNamespace<AuthoritativeSqliteStore>;
};
const targetRequest = ({
  env,
  path,
}: Readonly<{ env: AdapterEnvironment; path: string }>): Promise<Response> => {
  const namespace = (
    source: typeof env.STORE | typeof env.INACTIVE
  ): { getByName: (name: string) => SqliteStoreBinding } => ({
    getByName: (name) => ({
      query: (input) => Promise.resolve<unknown>(source.getByName(name).query(input)),
    }),
  });
  if (path === "/target/d1") return targetProof({ DB: env.DB });
  if (path === "/target/missing") return targetProof({});
  if (path === "/target/both") {
    return targetProof({
      DB: env.DB,
      SQLITE_STORE: namespace(env.STORE),
      SQLITE_STORE_MANIFEST: "fixture",
      SQLITE_STORE_EPOCH: "fixture",
    });
  }
  return targetProof({
    SQLITE_STORE: namespace(path === "/target/inactive" ? env.INACTIVE : env.STORE),
    SQLITE_STORE_MANIFEST: "fixture",
    SQLITE_STORE_EPOCH: "fixture",
  });
};
const controlRequest = ({
  env,
  request,
  path,
}: Readonly<{ env: AdapterEnvironment; request: Request; path: string }>): Promise<Response> => {
  const store = env.STORE.getByName("store");
  if (path === "/control/inspect") {
    return Promise.resolve<unknown>(store.inspect()).then(Response.json);
  }
  return request
    .json()
    .then<unknown>((input) =>
      path === "/control/close" ? store.close(input) : store.controlQuery(input)
    )
    .then(Response.json);
};
export default {
  fetch: (request: Request, env: AdapterEnvironment): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/control/")) return controlRequest({ env, request, path });
    if (path.startsWith("/target/")) return targetRequest({ env, path });
    if (path === "/inspect-d1") {
      return env.DB.prepare("SELECT name FROM sqlite_master WHERE name='target_receipts'")
        .first()
        .then(Response.json);
    }
    if (path === "/remote") {
      const db = makeRemoteSqliteDatabase({
        manifest: "fixture",
        epoch: "fixture",
        store: {
          query: (input) => Promise.resolve<unknown>(env.STORE.getByName("store").query(input)),
        },
      });
      return bindingsProof(db);
    }
    if (path === "/rpc" || path === "/inactive") {
      const store = path === "/rpc" ? env.STORE : env.INACTIVE;
      return request
        .json()
        .then<unknown>((body) =>
          store.getByName(request.headers.get("x-store-object") ?? "store").query({
            manifest: request.headers.get("x-store-manifest") ?? "fixture",
            epoch: request.headers.get("x-store-epoch") ?? "fixture",
            query: body,
          })
        )
        .then(Response.json);
    }
    return env.PROOF.getByName("synthetic").fetch(request);
  },
};
