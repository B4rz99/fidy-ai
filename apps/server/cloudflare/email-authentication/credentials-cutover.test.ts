import { UserId } from "../../src/core/identity/contract";
import { afterAll, expect, it } from "vitest";
import { Cause, Data, Effect, Option, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { verifiedEmailQuery } from "./operations";

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
  `14400000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const objects = (source: string): ReadonlyArray<string> =>
  source
    .split("--> statement-breakpoint")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
const name = (sql: string): string =>
  /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER|VIEW) "?(\w+)"?/u.exec(sql)?.[1] ?? "";
const definition = (source: ReadonlyArray<string>, target: string): string => {
  const found = source.find((sql) => name(sql) === target);
  if (found === undefined) throw Error("Missing credential cutover source definition");
  return found;
};
const fences = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source.filter((sql) => name(sql).startsWith("verified_email_credentials_field_fence_"));
const block = (guide: string, section: string): ReadonlyArray<string> => {
  const value = guide.match(
    new RegExp(
      `<!-- email-credential-${section}:start -->\\s*\x60\x60\x60sql\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- email-credential-${section}:end -->`,
      "u"
    )
  )?.[1];
  if (value === undefined) throw Error("Missing documented email credential cutover");
  return value
    .split(";")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
};
const seed = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[1, 2, 3].map((ordinal) =>
      db
        .prepare(`INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms,verified_email_address,email_verified_at_ms)
    VALUES(?,?,'CO','es-CO','America/Bogota',?,?,?,?,?)`)
        .bind(
          ordinal * 7,
          id(ordinal),
          current - 20000,
          current - 20000,
          current - 20000 + 604800000,
          ordinal === 3 ? null : `original${ordinal}@example.test`,
          ordinal === 3 ? null : current - 10000 - ordinal
        )
    ),
    db
      .prepare(
        "UPDATE users SET whatsapp_portfolio_id='original-portfolio',whatsapp_bsuid='original-recipient',whatsapp_verified_at_ms=? WHERE id=?"
      )
      .bind(current - 15000, id(1)),
    db
      .prepare(
        "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,'BCDF-GHJK',zeroblob(32),?,'consumed',?,?)"
      )
      .bind(id(4), id(1), current - 3000, current + 597000),
    db
      .prepare(
        "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,zeroblob(32),?,?,?,?)"
      )
      .bind(
        id(4),
        id(4),
        id(1),
        current - 3000,
        current + 597000,
        current + 3600000,
        current - 3000 + 7776000000
      ),
    db
      .prepare(`INSERT INTO email_replacements(user_id,work_id,session_id,candidate_email,prior_email,prior_verified_at_ms,state,public_code,proof_digest,proof_expires_at_ms,created_at_ms,expires_at_ms,wrong_attempts,dispatch_attempted_at_ms)
    VALUES(?,?,?,'candidate@example.test','original1@example.test',?,'awaiting_proof','BCDF-HJKM',zeroblob(32),?,?,?,2,?)`)
      .bind(
        id(1),
        id(5),
        id(4),
        current - 10001,
        current + 100000,
        current - 2000,
        current + 598000,
        current - 1000
      ),
    db
      .prepare(
        "INSERT INTO provider_credentials(issuer,subject,user_id,contact_email,established_at_ms) VALUES('provider','subject',?,'contact@example.test',?)"
      )
      .bind(id(3), current - 100),
    db
      .prepare(
        "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',?,'Complete')"
      )
      .bind(current),
    db.prepare(
      "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','verified_email_credentials','initial:7','{}',1)"
    ),
  ]);
const queryPlans = (db: D1Database, credential: string): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    db.prepare(`EXPLAIN QUERY PLAN ${credential}`).bind(id(1)),
    db
      .prepare(`EXPLAIN QUERY PLAN DELETE FROM email_replacements WHERE user_id IN
    (SELECT user_id FROM email_replacements WHERE expires_at_ms <= ? LIMIT 32)`)
      .bind(current),
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
    db.prepare("SELECT rowid,* FROM email_replacements ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM erasure_archives ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM provider_credentials ORDER BY rowid"),
  ]);
type CutoverCase =
  | Readonly<{ _tag: "Complete"; outcome: "complete" }>
  | Readonly<{ _tag: "Source" | "AfterCopy" | "AfterRemove"; outcome: string; sql: string }>;
const cases: ReadonlyArray<CutoverCase> = [
  { _tag: "Complete", outcome: "complete" },
  {
    _tag: "Source",
    outcome: "address_without_instant",
    sql: "UPDATE users SET email_verified_at_ms=NULL WHERE verified_email_address IS NOT NULL",
  },
  {
    _tag: "Source",
    outcome: "instant_without_address",
    sql: "UPDATE users SET verified_email_address=NULL WHERE email_verified_at_ms IS NOT NULL",
  },
  {
    _tag: "Source",
    outcome: "non_normalized_evidence",
    sql: "UPDATE users SET verified_email_address='Original1@example.test' WHERE rowid=7",
  },
  {
    _tag: "Source",
    outcome: "duplicate_address",
    sql: "UPDATE users SET verified_email_address='original1@example.test' WHERE rowid=14",
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
    sql: "INSERT INTO verified_email_credentials(user_id,address,verified_at_ms) VALUES('foreign','foreign@example.test',0)",
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
  ...(fixture.outcome === "duplicate_address" ? ["DROP INDEX users_verified_email"] : []),
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
  "preserves current login authority and pending replacement through a $outcome cutover",
  (fixture) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* native(() => databases.acquire());
        yield* native(() => installTestSchema({ db }));
        const baseline = objects(
          yield* native(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const source = objects(
          yield* native(() =>
            Bun.file(new URL("./credentials-before-1440.fixture.sql", import.meta.url)).text()
          )
        );
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
              ...targetFences.map((sql) => `DROP TRIGGER ${name(sql)}`),
              ...userDependents.map(
                (sql) =>
                  `DROP ${sql.startsWith("CREATE TRIGGER") ? "TRIGGER" : "VIEW"} ${name(sql)}`
              ),
              "DROP TABLE verified_email_credentials",
              "DROP TABLE users",
              definition(source, "users"),
              ...userIndexes,
              ...userDependents,
              ...source.filter((sql) => !sql.startsWith("CREATE TABLE")),
            ].map((sql) => db.prepare(sql))
          )
        );
        yield* native(() => seed(db));
        if (fixture._tag === "Source") {
          yield* native(() => db.batch(corruptSource(fixture).map((sql) => db.prepare(sql))));
        }
        const before = yield* native(() =>
          db.prepare("SELECT rowid,* FROM users ORDER BY rowid").all()
        );
        const companions = yield* native(() => retained(db));
        const plansBefore = yield* native(() =>
          queryPlans(
            db,
            "SELECT user_id AS userId,email_address AS emailAddress FROM (SELECT rowid,id AS user_id,verified_email_address AS email_address,email_verified_at_ms AS verified_at_ms FROM users WHERE verified_email_address IS NOT NULL) WHERE user_id = ?"
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
                ...block(guide, "preflight"),
                definition(baseline, "verified_email_credentials"),
                ...block(guide, "copy"),
                ...injectFault(fixture, "AfterCopy"),
                ...sourceFences.map((sql) => `DROP TRIGGER ${name(sql)}`),
                ...block(guide, "remove-source"),
                ...targetFences,
                ...injectFault(fixture, "AfterRemove"),
                ...block(guide, "verify"),
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
          return;
        }
        expect(after.results).toEqual(
          before.results.map((row) => {
            const retained = { ...row };
            delete retained.verified_email_address;
            delete retained.email_verified_at_ms;
            return retained;
          })
        );
        expect(
          (yield* native(() =>
            db.prepare("SELECT rowid,* FROM verified_email_credentials ORDER BY rowid").all()
          )).results
        ).toEqual([
          {
            rowid: 7,
            user_id: id(1),
            address: "original1@example.test",
            verified_at_ms: current - 10001,
          },
          {
            rowid: 14,
            user_id: id(2),
            address: "original2@example.test",
            verified_at_ms: current - 10002,
          },
        ]);
        const query = verifiedEmailQuery({ userId: UserId.make(id(1)) });
        const plansAfter = yield* native(() => queryPlans(db, query.sql));
        assertQueryPlans(plansBefore, plansAfter);
        expect(
          yield* native(() =>
            db
              .prepare(query.sql)
              .bind(...query.params)
              .first()
          )
        ).toEqual({ userId: id(1), emailAddress: "original1@example.test" });
        expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
      })
    )
);
