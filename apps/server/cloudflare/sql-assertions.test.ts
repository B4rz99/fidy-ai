import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  prepareChangedRowAssertion,
  preparePredicateAssertion,
} from "../src/shell/sql-assertions/operations";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const run = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);

it.live(
  "commits chained checks and rolls back all writes when a reused scope's prerequisite fails",
  () =>
    Effect.gen(function* () {
      const db = yield* run(() => databases.acquire());
      yield* run(() => installTestSchema({ db }));
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
          db
            .prepare(
              "SELECT scope, accepted FROM sql_assertions WHERE scope IN ('dashboard','recurring_plan') ORDER BY scope"
            )
            .all()
        )).results
      ).toEqual([
        { scope: "dashboard", accepted: 1 },
        { scope: "recurring_plan", accepted: 1 },
      ]);
    })
);

it.live("keeps specialized assertion failures atomic within each scope", () =>
  Effect.gen(function* () {
    const db = yield* run(() => databases.acquire());
    yield* run(() => installTestSchema({ db }));
    yield* run(() =>
      db.batch([
        db.prepare("CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT"),
        db.prepare("INSERT INTO records VALUES('purchase','original')"),
        ...[
          "canonical_request",
          "commercial_allowance",
          "connection_browser",
          "media_capacity",
          "media_publication",
          "recurring_cursor",
        ].map((scope) =>
          db
            .prepare(
              "INSERT INTO sql_assertions(scope,accepted) VALUES (?,1) ON CONFLICT(scope) DO UPDATE SET accepted=1"
            )
            .bind(scope)
        ),
      ])
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
