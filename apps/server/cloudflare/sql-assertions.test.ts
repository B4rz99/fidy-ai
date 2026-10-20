import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  prepareChangedRowAssertion,
  preparePredicateAssertion,
} from "../src/shell/sql-assertions/operations";
import { applyTestMigration, installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const run = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);

it.live(
  "commits chained checks and rolls back all writes when a reused scope's prerequisite fails",
  () =>
    Effect.gen(function* () {
      const db = yield* run(() => databases.acquire());
      yield* run(() => installTestSchema({ db, sources: [] }));
      yield* run(() =>
        db.prepare("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT").run()
      );
      yield* run(() =>
        db.batch([
          db.prepare("INSERT INTO records VALUES ('purchase', 'original')"),
          prepareChangedRowAssertion({ db, scope: "dashboard" }),
          prepareChangedRowAssertion({ db, scope: "recurring_plan" }),
        ])
      );

      yield* run(() =>
        expect(
          db.batch([
            db.prepare("UPDATE records SET value='partial' WHERE id='purchase'"),
            prepareChangedRowAssertion({ db, scope: "dashboard" }),
            db.prepare("UPDATE records SET value='missing' WHERE id='absent'"),
            prepareChangedRowAssertion({ db, scope: "recurring_plan" }),
          ])
        ).rejects.toThrow()
      );

      expect(
        yield* run(() => db.prepare("SELECT value FROM records WHERE id='purchase'").first("value"))
      ).toBe("original");
      expect(
        (yield* run(() =>
          db.prepare("SELECT scope, accepted FROM sql_assertions ORDER BY scope").all()
        )).results
      ).toEqual([
        { scope: "dashboard", accepted: 1 },
        { scope: "recurring_plan", accepted: 1 },
      ]);
    })
);

it.live(
  "preserves populated singleton slots and uninitialized slots through the consolidation migration",
  () =>
    Effect.gen(function* () {
      const db = yield* run(() => databases.acquire());
      const source = new URL("./migrations/0114_consolidate_assertions.sql", import.meta.url);
      const sources = Array.from(
        new Bun.Glob("*.sql").scanSync(new URL("./migrations/", import.meta.url).pathname)
      )
        .filter((name) => name < "0114_consolidate_assertions.sql")
        .sort()
        .map((name) => new URL(`./migrations/${name}`, import.meta.url));
      for (const historicalSource of sources) {
        yield* run(() => applyTestMigration({ db, source: historicalSource }));
      }
      yield* run(() =>
        db.batch([
          db.prepare("INSERT INTO pat_atomic_assertion VALUES (1,1)"),
          db.prepare("INSERT INTO proactivity_message_assertion VALUES (1,1)"),
        ])
      );

      yield* run(() => applyTestMigration({ db, source }));

      expect(
        (yield* run(() =>
          db.prepare("SELECT scope, accepted FROM sql_assertions ORDER BY scope").all()
        )).results
      ).toEqual([
        { scope: "pat_atomic", accepted: 1 },
        { scope: "proactivity_message", accepted: 1 },
      ]);
      expect(
        (yield* run(() =>
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name IN ('pat_atomic_assertion','proactivity_message_assertion')"
            )
            .all()
        )).results
      ).toEqual([]);
      expect((yield* run(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
    })
);

it.live("preserves initialized controls and scoped rollback failures through consolidation", () =>
  Effect.gen(function* () {
    const db = yield* run(() => databases.acquire());
    const directory = new URL("./migrations/", import.meta.url);
    const names = [...new Bun.Glob("*.sql").scanSync(directory.pathname)]
      .filter((name) => name < "0130_")
      .sort();
    for (const name of names) {
      yield* run(() => applyTestMigration({ db, source: new URL(name, directory) }));
    }
    yield* run(() =>
      db.batch([
        db.prepare("CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT"),
        db.prepare("INSERT INTO records VALUES('purchase','original')"),
        db.prepare("INSERT INTO canonical_request_assertions VALUES('first',1),('second',1)"),
        db.prepare("INSERT INTO commercial_allowance_assertions VALUES('allowance',1)"),
        db.prepare("INSERT INTO connection_browser_atomic_assertion VALUES(1,1)"),
        db.prepare("INSERT INTO media_publication_assertions VALUES('media',1,1)"),
        db.prepare("INSERT INTO recurring_cursor_assertion VALUES(1,7,7)"),
      ])
    );
    yield* run(() =>
      applyTestMigration({ db, source: new URL("0130_specialized_assertions.sql", directory) })
    );
    const failures = [
      ["canonical_request", "canonical_request_rate"],
      ["commercial_allowance", "commercial_authority_required"],
      ["connection_browser", "connection_browser_commit"],
      ["media_capacity", "media_work_capacity"],
      ["media_publication", "media_publication_required"],
      ["recurring_cursor", "recurring_cursor_changed"],
    ] as const;
    for (const [scope, failure] of failures) {
      expect(
        yield* run(() =>
          db
            .prepare("SELECT accepted FROM sql_assertions WHERE scope=?")
            .bind(scope)
            .first("accepted")
        )
      ).toBe(1);
      yield* run(() =>
        expect(
          db.batch([
            db.prepare("UPDATE records SET value='partial' WHERE id='purchase'"),
            preparePredicateAssertion({
              db,
              scope,
              predicate: { sql: "SELECT 1 WHERE 0", params: [] },
            }),
          ])
        ).rejects.toThrow(failure)
      );
    }
    yield* run(() =>
      expect(
        db.batch([
          db.prepare("UPDATE records SET value='partial' WHERE id='purchase'"),
          db.prepare("UPDATE sql_assertions SET accepted=NULL WHERE scope='media_capacity'"),
        ])
      ).rejects.toThrow("media_work_capacity")
    );
    expect(
      yield* run(() => db.prepare("SELECT value FROM records WHERE id='purchase'").first("value"))
    ).toBe("original");
    expect((yield* run(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
  })
);
