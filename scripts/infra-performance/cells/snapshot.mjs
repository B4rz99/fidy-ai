// Extract only the empty schema produced by the frozen migrations and reconstruct it in fresh D1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { Schema } from "effect";

/** @typedef {{sql:string,params:ReadonlyArray<unknown>,check?:string}} Query */
/** @typedef {{batch: Query[], reads:number,writes:number}} Batch */
/** @typedef {{name:string,type:string,tbl_name:string,sql:string|null}} Definition */
/** @typedef {{name:string, read:Query, inserts:string[], identities:string[], rowCount:number, dependencies:string[]}} Table */
const emptyBatchSize = 15;
const Rows = Schema.Array(Schema.Record(Schema.String, Schema.Json));
const encodedRows = Schema.decodeUnknownSync(Rows);
const QueryShape = Schema.Struct({ sql: Schema.String, params: Schema.Array(Schema.Json) });
const Plan = Schema.StructWithRest(
  Schema.Struct({
    baseline: Schema.String,
    batches: Schema.Array(
      Schema.StructWithRest(Schema.Struct({ batch: Schema.Array(QueryShape) }), [
        Schema.Record(Schema.String, Schema.Json),
      ])
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)]
);
const readPlan = Schema.decodeUnknownSync(Plan);
const readSchema = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      tbl_name: Schema.String,
      sql: Schema.NullOr(Schema.String),
    })
  )
);
const readColumns = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ name: Schema.String, hidden: Schema.Int }))
);
const readDependencies = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ table: Schema.String }))
);
const readValues = Schema.decodeUnknownSync(
  Schema.Array(Schema.Record(Schema.String, Schema.String))
);
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name";
const triggerSql =
  "SELECT tbl_name,name FROM sqlite_schema WHERE type='trigger' ORDER BY tbl_name,rowid";
const output = resolve(process.argv[2]);
const file = resolve(output, "plan.json");
const report = resolve(output, "snapshot-proof.json");
const plan = readPlan(await Bun.file(file).json());
const start = plan.batches.findIndex((group) =>
  group.batch[0]?.sql.startsWith(
    "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES"
  )
);
assert.ok(start > 0, "Cannot separate frozen migrations from the first synthetic User");
const original = plan.batches.slice(0, start);
const prefix = original.flatMap((group) => group.batch);
const migrationDir = "apps/server/cloudflare/migrations";
/** @param {string[]} args Frozen Git invocation. */
const git = (args) => execFileSync("git", args, { encoding: "utf8" });
const files = git(["ls-tree", "-r", "--name-only", plan.baseline, "--", migrationDir])
  .trim()
  .split("\n")
  .filter((name) => name.endsWith(".sql"))
  .sort();
const trusted = files.flatMap((name) =>
  git(["show", plan.baseline + ":" + name])
    .split("--> statement-breakpoint")
    .map((sql) => sql.trim())
    .filter(Boolean)
);
assert.deepEqual(
  prefix.map((entry) => entry.sql),
  trusted
);
assert.ok(prefix.every((entry) => entry.params.length === 0));
/** @param {string} value Hash input. */
const hash = (value) => createHash("sha256").update(value).digest("hex");
/** @param {unknown} rows Exact SELECT result. */
const digest = (rows) =>
  hash(
    JSON.stringify(
      encodedRows(rows).map((row) =>
        Object.entries(row).sort(([left], [right]) => left.localeCompare(right))
      )
    )
  );
/** @param {string} identifier Identifier originating in the frozen database schema. */
const id = (identifier) => '"' + identifier.replaceAll('"', '""') + '"';
/** @param {string} sql Trusted SQL. */
const query = (sql) => ({ sql, params: [] });
/** @template T @param {ReadonlyArray<T>} items Ordered work. @param {(item:T)=>Promise<void>} action Scoped operation. */
const serial = (items, action) =>
  items.reduce((prior, item) => prior.then(() => action(item)), Promise.resolve());
/** @template T @param {ReadonlyArray<T>} items Native statements. */
const chunks = (items) =>
  Array.from({ length: Math.ceil(items.length / emptyBatchSize) }, (_, index) =>
    items.slice(index * emptyBatchSize, (index + 1) * emptyBatchSize)
  );
/** @param {D1Database} db Native database. @param {Query} command Trusted query. */
const select = async (db, command) =>
  (
    await db
      .prepare(command.sql)
      .bind(...command.params)
      .all()
  ).results;
/** @param {D1Database} db Disposable database. */
const physical = async (db) => {
  try {
    return {
      pages: await select(db, query("PRAGMA page_count")),
      freelist: await select(db, query("PRAGMA freelist_count")),
    };
  } catch {
    return { scope: "Physical page metadata unavailable from native D1" };
  }
};
/** @param {D1Database} db Restored database. @param {Query[]} batch One bounded batch. @returns {Promise<Batch>} */
const run = async (db, batch) => {
  const results = await db.batch(batch.map((entry) => db.prepare(entry.sql).bind(...entry.params)));
  assert.equal(results.length, batch.length);
  const billed = { batch, reads: 0, writes: 0 };
  for (const [index, reply] of results.entries()) {
    assert.ok(
      Number.isSafeInteger(reply.meta.rows_read) && Number.isSafeInteger(reply.meta.rows_written)
    );
    assert.equal(reply.success, true);
    billed.reads += reply.meta.rows_read;
    billed.writes += reply.meta.rows_written;
    const expected = batch[index]?.check;
    if (expected) assert.equal(digest(reply.results), expected, "Final D1 verification differs");
  }
  return billed;
};
/** @param {string} field Quoted trusted SQLite expression. */
const literal = (field) =>
  `CASE typeof(${field}) WHEN 'text' THEN 'CAST(X''' || hex(CAST(${field} AS BLOB)) || ''' AS TEXT)' ELSE quote(${field}) END`;
/** @param {D1Database} db Oracle database. @param {Definition} def Native table. @returns {Promise<Table>} */
const captureTable = async (db, def) => {
  assert.ok(def.sql);
  const name = id(def.name);
  const columns = readColumns(await select(db, query("PRAGMA table_xinfo(" + name + ")")));
  assert.ok(columns.length);
  const fields = columns.map((col) => col.name);
  if (!/\bWITHOUT\s+ROWID\b/iu.test(def.sql)) {
    assert.ok(!fields.includes("_rowid_"));
    fields.unshift("_rowid_");
  }
  const keys = fields.map((_, index) => "c" + index);
  const projected = fields.map((field, index) => literal(id(field)) + " AS " + keys[index]);
  const read = query(
    "SELECT " + projected.join(",") + " FROM " + name + " ORDER BY " + keys.join(",")
  );
  const rows = readValues(await select(db, read));
  const insertable = fields.filter(
    (field) => !columns.some((col) => col.name === field && col.hidden !== 0)
  );
  const inserts = rows.map(
    (row) =>
      "INSERT INTO " +
      name +
      "(" +
      insertable.map(id).join(",") +
      ") VALUES(" +
      insertable.map((field) => row["c" + fields.indexOf(field)]).join(",") +
      ")"
  );
  const dependencies = readDependencies(
    await select(db, query("PRAGMA foreign_key_list(" + name + ")"))
  ).map((item) => item.table);
  return {
    name: def.name,
    read: { ...read, check: digest(rows) },
    inserts,
    identities: rows.map((row) => digest([row])),
    rowCount: rows.length,
    dependencies,
  };
};
/** @param {ReadonlyArray<Table>} tables Source-owned tables. */
const seedOrder = (tables) => {
  const waiting = new Map(
    tables.filter((table) => table.rowCount > 0).map((table) => [table.name, table])
  );
  /** @type {Table[]} */
  const ordered = [];
  while (waiting.size) {
    const choice = Array.from(waiting.values()).find((table) =>
      table.dependencies.every((parent) => parent === table.name || !waiting.has(parent))
    );
    assert.ok(choice, "Cyclic initial facts require a separate reconstruction proof");
    ordered.push(choice);
    waiting.delete(choice.name);
  }
  return ordered;
};
const runtime = new Miniflare({
  workers: [
    {
      config: {
        type: "worker",
        name: "snapshot-probe",
        compatibilityDate: "2026-09-08",
        env: {
          ORACLE: { type: "d1", id: "migration-oracle" },
          RESTORED: { type: "d1", id: "snapshot-restore" },
        },
        manifest: {
          mainModule: "index.mjs",
          modules: {
            "index.mjs": {
              type: "esm",
              contents: "export default {fetch(){return new Response(null,{status:404})}}",
            },
          },
        },
      },
    },
  ],
});
/** @type {Record<string,unknown>} */
const evidence = {
  baseline: plan.baseline,
  migrations: files,
  verifiedPrefixStatements: trusted.length,
  foreignKeys: "enabled",
  stage: "replay",
};
try {
  const oracle = await runtime.getD1Database("ORACLE");
  const restored = await runtime.getD1Database("RESTORED");
  const pristine = readSchema(await select(oracle, query(schemaSql)));
  assert.deepEqual(readSchema(await select(restored, query(schemaSql))), pristine);
  await serial(original, async (group) => {
    await run(oracle, Array.from(group.batch));
  });
  const schema = readSchema(await select(oracle, query(schemaSql)));
  const originalOrder = readSchema(
    await select(oracle, query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY rowid"))
  );
  assert.equal(
    await oracle.prepare("SELECT count(*) AS n FROM users").first("n"),
    0,
    "Oracle already has a User"
  );
  evidence.stage = "extract";
  evidence.oraclePhysical = await physical(oracle);
  const platform = new Set(pristine.map((def) => def.name));
  const definitions = originalOrder.filter(
    (def) => !platform.has(def.name) && !def.name.startsWith("sqlite_") && def.sql !== null
  );
  const owned = schema.filter((def) => def.type === "table" && !platform.has(def.name));
  /** @type {Table[]} */
  const tables = [];
  await serial(owned, async (def) => {
    tables.push(await captureTable(oracle, def));
  });
  evidence.platformObjects = Array.from(platform);
  evidence.schemaObjects = schema.map(({ type, name, tbl_name, sql }) => ({
    type,
    name,
    table: tbl_name,
    sqlSha256: sql && hash(sql),
  }));
  evidence.seedTables = tables.map((table) => ({
    name: table.name,
    rows: table.rowCount,
    sha256: table.read.check,
  }));
  evidence.migrationLedgerTables = tables
    .map((table) => table.name)
    .filter((name) => /migration|drizzle/iu.test(name));
  /** @type {Batch[]} */
  const applied = [];
  /** @param {Query[]} entries Reviewed materialization statements. */
  const append = (entries) =>
    serial(chunks(entries), async (group) => {
      applied.push(await run(restored, Array.from(group)));
    });
  await append([{ ...query(schemaSql), check: digest(pristine) }]);
  await serial(["table", "index", "view", "trigger"], async (kind) => {
    const group = definitions
      .filter((def) => def.type === kind)
      .map((def) => query(String(def.sql)));
    evidence.stage = "define-" + kind;
    // Each kind is a dependency barrier; the source row order retains relative trigger order.
    await append(group);
  });
  await serial(seedOrder(tables), async (table) => {
    evidence.stage = "seed-" + table.name;
    const existing = readValues(await select(restored, table.read));
    if (digest(existing) === table.read.check) return;
    // Install the original constraints and triggers before the first seed row. Refuse side effects
    // that differ from the final snapshot and never overwrite, disable or drop a guard.
    const remaining = new Map(table.identities.map((key, index) => [key, table.inserts[index]]));
    assert.equal(remaining.size, table.rowCount, "Seed row identity collision");
    for (const row of existing) {
      assert.equal(
        remaining.delete(digest([row])),
        true,
        "Reconstruction produced a foreign seed row"
      );
    }
    await append(
      Array.from(remaining.values()).map((sql) => {
        assert.ok(sql);
        return query(sql);
      })
    );
  });
  evidence.stage = "verify";
  const fk = query("PRAGMA foreign_key_check");
  const violations = await select(oracle, fk);
  assert.deepEqual(violations, []);
  await append([
    { ...query(schemaSql), check: digest(schema) },
    { ...query(triggerSql), check: digest(await select(oracle, query(triggerSql))) },
    ...tables.map((table) => table.read),
    { ...fk, check: digest(violations) },
  ]);
  const cost = applied.reduce(
    (sum, batch) => ({
      rowsRead: sum.rowsRead + batch.reads,
      rowsWritten: sum.rowsWritten + batch.writes,
    }),
    { rowsRead: 0, rowsWritten: 0 }
  );
  const schemaSnapshot = {
    schemaSha256: digest(schema),
    triggerOrderSha256: digest(await select(oracle, query(triggerSql))),
    migrationPrefixSha256: hash(JSON.stringify(prefix)),
    cost,
  };
  evidence.snapshot = schemaSnapshot;
  evidence.batches = applied.length;
  evidence.restoredPhysical = await physical(restored);
  evidence.stage = "equivalent";
  await Bun.write(
    file,
    JSON.stringify({ ...plan, schemaSnapshot, batches: [...applied, ...plan.batches.slice(start)] })
  );
} finally {
  await Bun.write(report, JSON.stringify(evidence, null, 2));
  await runtime.dispose();
}
