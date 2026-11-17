// Generate every hosted statement from the pinned migrations and trusted measurement fixture.
import { Effect, Option, Schema } from "effect";
import {
  type RecordMeasuredStatement,
  isolatedTestDatabases,
  observeFixtureStatements,
} from "../cloudflare/d1-test-fixture";
import { seedAssessment } from "../cloudflare/browser-assessment.test-fixture";

const baseline = "fb53d9e755c14393048dc945fc0b7f117730d872";
const seedEpochMs = 1794916800000;
const migrationDir = "apps/server/cloudflare/migrations";
const batchSize = 15;
const git = (...args: Array<string>): string => {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) throw new Error("Pinned Git revision unavailable");
  return result.stdout.toString();
};
const pool = isolatedTestDatabases();
type Batch = {
  batch: Array<Readonly<{ sql: string; params: ReadonlyArray<unknown> }>>;
  reads: number;
  writes: number;
};

const prepare = Effect.gen(function* () {
  const destination = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(process.argv[2]);
  const native = yield* Effect.tryPromise(() => pool.acquire());
  const batches: Array<Batch> = [];
  const record: RecordMeasuredStatement = (request, query, counters) => {
    if (request > batches.length) batches.push({ batch: [], reads: 0, writes: 0 });
    const entry = batches[request - 1];
    if (entry === undefined) throw new Error("Nonconsecutive native D1 batch");
    for (const value of [counters.rowsRead, counters.rowsWritten]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Missing native D1 metadata");
      }
    }
    entry.batch.push(query);
    entry.reads += counters.rowsRead;
    entry.writes += counters.rowsWritten;
  };
  const { database: db } = observeFixtureStatements({
    db: native,
    onMeasuredStatement: Option.some(record),
  });
  const files = git("ls-tree", "--name-only", "-r", baseline, "--", migrationDir)
    .trim()
    .split("\n")
    .filter((path) => path.endsWith(".sql"))
    .sort();
  if (files.length === 0) return yield* Effect.die(new Error("Pinned migrations missing"));
  for (const file of files) {
    const statements = git("show", baseline + ":" + file)
      .split("--> statement-breakpoint")
      .map((sql) => sql.trim())
      .filter(Boolean);
    for (let offset = 0; offset < statements.length; offset += batchSize) {
      const page = statements.slice(offset, offset + batchSize);
      yield* Effect.tryPromise(() => db.batch(page.map((sql) => db.prepare(sql))));
    }
  }
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
      )
      .bind("24000000-0000-4000-8000-000000000481")
      .run()
  );
  const verified = yield* seedAssessment({ db, dataset: "production", now: seedEpochMs });
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    baseline,
    seedEpochMs,
    verified,
    batches,
  });
  yield* Effect.tryPromise(() => Bun.write(destination, encoded));
});

await Effect.runPromise(
  prepare.pipe(Effect.ensuring(Effect.tryPromise(() => pool.dispose()).pipe(Effect.orDie)))
);
