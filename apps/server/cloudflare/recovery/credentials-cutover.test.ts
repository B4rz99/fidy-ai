import {
  documentedSqlBlock,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { afterAll, expect, it } from "vitest";
import { Cause, Data, Effect, Option, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new FixtureFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const current = 1_800_000_000_123;
const id = (ordinal: number): string =>
  `14410000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const fences = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source.filter((sql) =>
    schemaObjectName(sql).startsWith("backup_recovery_credentials_field_fence_")
  );
const seed = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[1, 2, 3].map((ordinal) =>
      db
        .prepare(`INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms,recovery_code_digest,recovery_created_at_ms,recovery_consumed_at_ms,recovery_revision)
      VALUES(?,?,'CO','es-CO','America/Bogota',?,?,?,?,?,?,?)`)
        .bind(
          ordinal * 7,
          id(ordinal),
          current - 20000,
          current - 20000,
          current - 20000 + 604800000,
          ordinal === 3 ? null : new Uint8Array(32).fill(ordinal),
          ordinal === 3 ? null : current - 10000 - ordinal,
          ordinal === 2 ? current - 50 : null,
          ordinal === 3 ? null : ordinal + 2
        )
    ),
    db
      .prepare(
        "INSERT INTO verified_email_credentials(user_id,address,verified_at_ms) VALUES(?,'original@example.test',?)"
      )
      .bind(id(1), current - 100),
    db
      .prepare(
        "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,'BCDF-GHJK',zeroblob(32),?,'consumed',?,?)"
      )
      .bind(id(4), id(2), current - 3000, current + 597000),
    db
      .prepare(
        "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,zeroblob(32),?,?,?,?)"
      )
      .bind(
        id(4),
        id(4),
        id(2),
        current - 3000,
        current + 597000,
        current + 3600000,
        current - 3000 + 7776000000
      ),
    db
      .prepare(
        "INSERT INTO support_recovery_cases(id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms) VALUES(?,?,?,'original-issuer','original-operator',4,?,?,'approved',?)"
      )
      .bind(id(5), id(2), id(4), current - 50, current + 597000, current - 50),
    db
      .prepare(
        "INSERT INTO audit_entries(record_type,id,recovery_case_id,user_id,operator_issuer,operator_subject,recovery_action,occurred_at_ms) VALUES('support_recovery',?,?,?,'original-issuer','original-operator','approved',?)"
      )
      .bind(id(6), id(5), id(2), current - 50),
    db
      .prepare(
        "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',?,'Complete')"
      )
      .bind(current),
    db.prepare(
      "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','backup_recovery_credentials','initial:7','{}',1)"
    ),
  ]);
const queryPlans = (db: D1Database, credential: string): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    db.prepare(`EXPLAIN QUERY PLAN ${credential}`).bind(new Uint8Array(32).fill(1)),
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id,closed_at_ms FROM support_recovery_cases ORDER BY closed_at_ms,id LIMIT ?"
      )
      .bind(32),
  ]);
const assertQueryPlans = (
  before: ReadonlyArray<D1Result>,
  after: ReadonlyArray<D1Result>
): void => {
  const PlanRows = Schema.Array(Schema.Struct({ detail: Schema.String }));
  for (const plan of [before[0], after[0]]) {
    const details = Schema.decodeUnknownSync(PlanRows)(plan?.results)
      .map((row) => row.detail)
      .join(" ");
    expect(details).toContain("SEARCH");
    expect(details).not.toContain("SCAN");
  }
  expect(after[1]?.results).toEqual(before[1]?.results);
};
const retained = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    db.prepare("SELECT rowid,* FROM web_sessions ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM browser_login_pairings ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM support_recovery_cases ORDER BY rowid"),
    db.prepare("SELECT * FROM audit_entries ORDER BY sequence"),
    db.prepare("SELECT rowid,* FROM erasure_archives ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM verified_email_credentials ORDER BY rowid"),
  ]);
type CutoverCase =
  | Readonly<{ _tag: "Complete"; outcome: "complete" }>
  | Readonly<{ _tag: "Source" | "AfterCopy" | "AfterRemove"; outcome: string; sql: string }>;
const cases: ReadonlyArray<CutoverCase> = [
  { _tag: "Complete", outcome: "complete" },
  {
    _tag: "Source",
    outcome: "digest_without_instant",
    sql: "UPDATE users SET recovery_created_at_ms=NULL WHERE rowid=7",
  },
  {
    _tag: "Source",
    outcome: "digest_without_revision",
    sql: "UPDATE users SET recovery_revision=NULL WHERE rowid=7",
  },
  {
    _tag: "Source",
    outcome: "consumption_without_digest",
    sql: "UPDATE users SET recovery_consumed_at_ms=1 WHERE rowid=21",
  },
  {
    _tag: "Source",
    outcome: "malformed_digest",
    sql: "UPDATE users SET recovery_code_digest=zeroblob(31) WHERE rowid=7",
  },
  {
    _tag: "Source",
    outcome: "duplicate_digest",
    sql: "UPDATE users SET recovery_code_digest=(SELECT recovery_code_digest FROM users WHERE rowid=7) WHERE rowid=14",
  },
  {
    _tag: "AfterCopy",
    outcome: "interrupted_after_copy",
    sql: "INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)",
  },
  {
    _tag: "AfterRemove",
    outcome: "interrupted_after_column_removal",
    sql: "INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)",
  },
  {
    _tag: "AfterRemove",
    outcome: "foreign_credential",
    sql: "INSERT INTO backup_recovery_credentials(user_id,code_digest,created_at_ms,revision) VALUES('foreign',zeroblob(32),0,1)",
  },
];
const injectFault = (
  fixture: CutoverCase,
  stage: "AfterCopy" | "AfterRemove"
): ReadonlyArray<string> => (fixture._tag === stage ? [fixture.sql] : []);
const corruptSource = (
  fixture: Exclude<CutoverCase, { _tag: "Complete" }>
): ReadonlyArray<string> => [
  "PRAGMA ignore_check_constraints=ON",
  fixture.sql,
  "PRAGMA ignore_check_constraints=OFF",
];
const assertFailure = (cause: Cause.Cause<FixtureFailure>, outcome: string): void => {
  const error = Cause.findErrorOption(cause);
  expect(Option.isSome(error)).toBe(true);
  if (Option.isSome(error)) {
    expect(String(error.value.cause)).toContain(
      outcome === "foreign_credential"
        ? "FOREIGN KEY constraint failed"
        : "CHECK constraint failed: accepted = 1"
    );
  }
};
it.each(cases)(
  "preserves one-use recovery authority and retained support evidence through a $outcome cutover",
  (fixture) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* native(() => databases.acquire());
        yield* native(() => installTestSchema({ db }));
        const baseline = schemaStatements(
          yield* native(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const source = schemaStatements(
          yield* native(() =>
            Bun.file(new URL("./credentials-before-1441.fixture.sql", import.meta.url)).text()
          )
        );
        const sourceNames = new Set(source.map(schemaObjectName));
        const sourceFences = fences(source);
        const targetFences = fences(baseline);
        const userIndexes = baseline.filter((sql) =>
          /^CREATE (?:UNIQUE )?INDEX .* ON users\b/u.test(sql)
        );
        const userDependents = baseline.filter(
          (sql) => /^CREATE (?:TRIGGER|VIEW) /u.test(sql) && /\busers\b/u.test(sql)
        );
        yield* native(() =>
          db.batch(
            [
              "PRAGMA defer_foreign_keys=ON",
              ...targetFences.map((sql) => `DROP TRIGGER ${schemaObjectName(sql)}`),
              ...userDependents.map(
                (sql) =>
                  `DROP ${sql.startsWith("CREATE TRIGGER") ? "TRIGGER" : "VIEW"} ${schemaObjectName(sql)}`
              ),
              "DROP TABLE backup_recovery_credentials",
              "DROP TABLE users",
              schemaDefinition({ source, target: "users" }),
              ...userIndexes,
              ...userDependents.filter((sql) => !sourceNames.has(schemaObjectName(sql))),
              ...source.filter((sql) => !sql.startsWith("CREATE TABLE")),
            ].map((sql) => db.prepare(sql))
          )
        );
        yield* native(() => seed(db));
        if (fixture._tag === "Source") {
          yield* native(() => db.batch(corruptSource(fixture).map((sql) => db.prepare(sql))));
        }
        const schemaBefore = yield* native(() =>
          db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()
        );
        const before = yield* native(() =>
          db.prepare("SELECT rowid,* FROM users ORDER BY rowid").all()
        );
        const companions = yield* native(() => retained(db));
        const plansBefore = yield* native(() =>
          queryPlans(
            db,
            "SELECT id AS user_id FROM users WHERE recovery_code_digest=? AND recovery_consumed_at_ms IS NULL"
          )
        );
        const guide = yield* native(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const result = yield* Effect.exit(
          native(() =>
            db.batch(
              [
                ...documentedSqlBlock({ guide, marker: "recovery-credential-preflight" }),
                schemaDefinition({ source: baseline, target: "backup_recovery_credentials" }),
                ...documentedSqlBlock({ guide, marker: "recovery-credential-copy" }),
                ...injectFault(fixture, "AfterCopy"),
                ...sourceFences.map((sql) => `DROP TRIGGER ${schemaObjectName(sql)}`),
                "DROP TRIGGER provider_completion_requires_proof",
                ...documentedSqlBlock({ guide, marker: "recovery-credential-remove-source" }),
                ...targetFences,
                schemaDefinition({
                  source: baseline,
                  target: "provider_completion_requires_proof",
                }),
                ...injectFault(fixture, "AfterRemove"),
                ...documentedSqlBlock({ guide, marker: "recovery-credential-verify" }),
              ].map((sql) => db.prepare(sql))
            )
          )
        );
        if (fixture._tag === "Complete" && result._tag === "Failure") {
          return yield* Effect.failCause(result.cause);
        }
        expect(result._tag).toBe(fixture._tag === "Complete" ? "Success" : "Failure");
        if (result._tag === "Failure") assertFailure(result.cause, fixture.outcome);
        expect((yield* native(() => retained(db))).map((value) => value.results)).toEqual(
          companions.map((value) => value.results)
        );
        const after = yield* native(() =>
          db.prepare("SELECT rowid,* FROM users ORDER BY rowid").all()
        );
        if (fixture._tag !== "Complete") {
          expect(after.results).toEqual(before.results);
          expect(
            (yield* native(() =>
              db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()
            )).results
          ).toEqual(schemaBefore.results);
          return;
        }
        expect(after.results).toEqual(
          before.results.map((row) => {
            const retained = { ...row };
            delete retained.recovery_code_digest;
            delete retained.recovery_created_at_ms;
            delete retained.recovery_consumed_at_ms;
            delete retained.recovery_revision;
            return retained;
          })
        );
        const credentials = yield* native(() =>
          db
            .prepare(
              "SELECT rowid,user_id,hex(code_digest) AS digest,created_at_ms,consumed_at_ms,revision FROM backup_recovery_credentials ORDER BY rowid"
            )
            .all()
        );
        expect(credentials.results).toEqual([
          {
            rowid: 7,
            user_id: id(1),
            digest: "01".repeat(32),
            created_at_ms: current - 10001,
            consumed_at_ms: null,
            revision: 3,
          },
          {
            rowid: 14,
            user_id: id(2),
            digest: "02".repeat(32),
            created_at_ms: current - 10002,
            consumed_at_ms: current - 50,
            revision: 4,
          },
        ]);
        assertQueryPlans(
          plansBefore,
          yield* native(() =>
            queryPlans(
              db,
              "SELECT user_id FROM backup_recovery_credentials WHERE code_digest=? AND consumed_at_ms IS NULL"
            )
          )
        );
        expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
      })
    )
);
