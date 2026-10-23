import { installHistoricalErasureStorage } from "../schema-cutover.test-fixture";
import { afterAll, expect, it } from "vitest";
import { Data, Effect, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { DisclosureSnapshot } from "../../src/core/consent/contract";
import { proactivityDisclosureFor, weeklyDisclosureFor } from "../../src/shell/consent/operations";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new FixtureFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14370000-0000-4000-8000-000000000001";
const foreign = "14370000-0000-4000-8000-000000000002";
const current = 1_800_000_000_123;
const disclosure = Schema.encodeSync(Schema.fromJsonString(DisclosureSnapshot));
const seed = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[owner, foreign].map((userId) =>
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
        )
        .bind(userId, current)
    ),
    ...[
      {
        id: "weekly",
        userId: owner,
        kind: "weekly-summary",
        json: disclosure(weeklyDisclosureFor()),
      },
      {
        id: "foreign-weekly",
        userId: foreign,
        kind: "weekly-summary",
        json: disclosure(weeklyDisclosureFor()),
      },
      {
        id: "budget",
        userId: owner,
        kind: "budget-threshold",
        json: disclosure(proactivityDisclosureFor("budget-threshold")),
      },
      {
        id: "foreign-budget",
        userId: foreign,
        kind: "budget-threshold",
        json: disclosure(proactivityDisclosureFor("budget-threshold")),
      },
      {
        id: "reminder",
        userId: owner,
        kind: "manual-entry-reminder",
        json: disclosure(proactivityDisclosureFor("manual-entry-reminder")),
      },
    ].map((offer) =>
      db
        .prepare(
          "INSERT INTO consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,disclosure_message_id,disclosed_at_ms,decision_message_id,decision) VALUES(?,?,?,'original-portfolio','original-recipient',?,?,?, ?,?,?,?)"
        )
        .bind(
          offer.id,
          offer.userId,
          offer.kind,
          offer.json,
          current,
          current + 600000,
          offer.kind === "weekly-summary" ? offer.id : null,
          offer.kind === "weekly-summary" ? current + 37 : null,
          offer.kind === "weekly-summary" ? `decline-${offer.id}` : null,
          offer.kind === "weekly-summary" ? "decline" : null
        )
    ),
    ...[owner, foreign].map((userId) =>
      db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,offer_id,decision_message_id,decision) VALUES('weekly_rejection',?,?,?,?, 'decline')"
        )
        .bind(
          userId,
          userId,
          userId === owner ? "weekly" : "foreign-weekly",
          `decline-${userId === owner ? "weekly" : "foreign-weekly"}`
        )
    ),
  ]);

it.each([
  {
    name: "foreign replacement",
    kind: "budget-threshold",
    rejection: null,
    replacement: "foreign-budget",
  },
  {
    name: "cross-category replacement",
    kind: "budget-threshold",
    rejection: null,
    replacement: "reminder",
  },
  {
    name: "missing replacement",
    kind: "budget-threshold",
    rejection: null,
    replacement: "missing",
  },
  { name: "foreign rejection", kind: "weekly-summary", rejection: foreign, replacement: null },
  { name: "missing rejection", kind: "weekly-summary", rejection: "missing", replacement: null },
])("refuses $name without leaving a partial offer", (candidate) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() => installHistoricalErasureStorage(db));
      yield* native(() => seed(db));
      expect(
        (yield* Effect.exit(
          native(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,rejection_id,replaces_offer_id) VALUES('candidate',?,?,'portfolio','recipient','{}',?,?,?,?)"
                )
                .bind(
                  owner,
                  candidate.kind,
                  current,
                  current + 600000,
                  candidate.rejection,
                  candidate.replacement
                ),
            ])
          )
        ))._tag
      ).toBe("Failure");
      expect(
        yield* native(() =>
          db.prepare("SELECT id FROM consent_offers WHERE id='candidate'").first()
        )
      ).toBe(null);
    })
  )
);

it.each([
  {
    name: "malformed weekly disclosure",
    sql: "INSERT INTO consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES('candidate',?,'p','b','not JSON',0,1)",
  },
  {
    name: "nonpositive weekly lifetime",
    sql: "INSERT INTO consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES('candidate',?,'p','b','{}',1,1)",
  },
  {
    name: "undisclosed decision insertion",
    sql: "INSERT INTO consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,decision,decision_message_id) VALUES('candidate',?,'p','b','{}',0,1,'accept','unproven')",
  },
  {
    name: "undisclosed decision update",
    sql: "UPDATE consent_offers SET decision='accept',decision_message_id='unproven' WHERE user_id=? AND id='budget'",
  },
  {
    name: "foreign weekly evidence",
    sql: "INSERT INTO consent_history(record_type,id,user_id,offer_id,decision_message_id,decision) VALUES('weekly_rejection','candidate',?,'foreign-weekly','foreign-decision','decline')",
  },
  {
    name: "foreign proactive evidence",
    sql: "INSERT INTO consent_history(record_type,id,user_id,kind,offer_id,decision_message_id,record_json,occurred_at_ms) VALUES('proactivity_grant','candidate',?,'budget-threshold','foreign-budget','foreign-decision','{}',0)",
  },
  {
    name: "cross-category proactive evidence",
    sql: "INSERT INTO consent_history(record_type,id,user_id,kind,offer_id,decision_message_id,record_json,occurred_at_ms) VALUES('proactivity_grant','candidate',?,'manual-entry-reminder','budget','foreign-decision','{}',0)",
  },
])("refuses $name atomically", (candidate) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() => installHistoricalErasureStorage(db));
      yield* native(() => seed(db));
      expect(
        (yield* Effect.exit(native(() => db.batch([db.prepare(candidate.sql).bind(owner)]))))._tag
      ).toBe("Failure");
      expect(
        (yield* native(() =>
          db
            .prepare(
              "SELECT id FROM consent_history WHERE id='candidate' UNION ALL SELECT id FROM consent_offers WHERE id='candidate'"
            )
            .all()
        )).results
      ).toEqual([]);
    })
  )
);

const block = (guide: string, name: string): ReadonlyArray<string> => {
  const sql = guide.match(
    new RegExp(
      `<!-- ${name}:start -->\\s*\x60\x60\x60sql\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- ${name}:end -->`,
      "u"
    )
  )?.[1];
  if (sql === undefined) throw Error("Missing documented Consent offer cutover");
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};
const snapshot = (
  db: D1Database
): Effect.Effect<
  Readonly<{
    offers: D1Result["results"];
    history: D1Result["results"];
    archives: D1Result["results"];
  }>,
  FixtureFailure
> =>
  Effect.gen(function* () {
    const offers = yield* native(() =>
      db.prepare("SELECT rowid,* FROM consent_offers ORDER BY rowid").all()
    );
    const history = yield* native(() =>
      db.prepare("SELECT * FROM consent_history ORDER BY sequence").all()
    );
    const archives = yield* native(() =>
      db.prepare("SELECT * FROM erasure_archives ORDER BY rowid").all()
    );
    return { offers: offers.results, history: history.results, archives: archives.results };
  });

it.each([
  "complete",
  "interrupted",
  "foreign_replacement",
  "foreign_rejection",
  "foreign_history",
  "invalid_disclosure",
  "missing_disclosure",
] as const)("preserves original Consent evidence through a %s offer cutover", (outcome) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() => installHistoricalErasureStorage(db));
      const baseline = yield* native(() =>
        Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
      );
      const guards = baseline
        .split("--> statement-breakpoint")
        .map((sql) => sql.trim())
        .filter((sql) =>
          /^CREATE TRIGGER (?:consent_offer_valid_(?:insert|update)|consent_history_offer_owner) /u.test(
            sql
          )
        );
      yield* native(() =>
        db.batch([
          db.prepare("DROP TRIGGER consent_offer_valid_insert"),
          db.prepare("DROP TRIGGER consent_offer_valid_update"),
          db.prepare("DROP TRIGGER consent_history_offer_owner"),
        ])
      );
      yield* native(() => seed(db));
      yield* native(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO consent_offers(rowid,id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,source_id,rejection_id) SELECT 77,'source-offer',user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms+100,created_at_ms+86400000,'original-question',? FROM consent_offers WHERE id='weekly'"
            )
            .bind(outcome === "foreign_rejection" ? foreign : owner),
          db
            .prepare(
              "INSERT INTO consent_offers(rowid,id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,replaces_offer_id) SELECT 101,'replacement',user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms+100,expires_at_ms+100,? FROM consent_offers WHERE id='budget'"
            )
            .bind(outcome === "foreign_replacement" ? "foreign-budget" : "budget"),
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('archive-request','removed-user',?,'Complete')"
            )
            .bind(current),
          db.prepare(
            "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('archive-request','proactivity_consent_offers','initial:500','{\"id\":\"original-offer\",\"disclosure_json\":\"original bytes\"}',1)"
          ),
          ...(outcome === "foreign_history"
            ? [
                db
                  .prepare(
                    "INSERT INTO consent_history(record_type,id,user_id,offer_id,decision_message_id,decision) VALUES('weekly_rejection','foreign-evidence',?,'foreign-weekly','foreign-choice','decline')"
                  )
                  .bind(owner),
              ]
            : []),
          ...(outcome === "invalid_disclosure"
            ? [
                db
                  .prepare(
                    "INSERT INTO consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES('invalid-json',?,'p','b','not JSON',0,1)"
                  )
                  .bind(owner),
              ]
            : []),
          ...(outcome === "missing_disclosure"
            ? [
                db
                  .prepare(
                    "INSERT INTO consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,decision,decision_message_id) VALUES('missing-disclosure',?,'p','b','{}',0,1,'accept','unproven')"
                  )
                  .bind(owner),
              ]
            : []),
        ])
      );
      const before = yield* snapshot(db);
      const guide = yield* native(() =>
        Bun.file(
          new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
        ).text()
      );
      const result = yield* Effect.exit(
        native(() =>
          db.batch(
            [
              ...block(guide, "consent-offers-preflight"),
              ...guards,
              ...(outcome === "interrupted"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('consent_offers_cutover',0)"]
                : []),
              ...block(guide, "consent-offers-verify"),
            ].map((sql) => db.prepare(sql))
          )
        )
      );
      expect(result._tag).toBe(outcome === "complete" ? "Success" : "Failure");
      expect(yield* snapshot(db)).toEqual(before);
      expect(
        (yield* native(() =>
          db.prepare("SELECT * FROM sql_assertions WHERE scope='consent_offers_cutover'").all()
        )).results
      ).toEqual([]);
      if (outcome === "complete") {
        expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
        // Expiry cleanup may remove an ancestor without extending the child's original evidence.
        yield* native(() => db.prepare("DELETE FROM consent_offers WHERE id='budget'").run());
        expect(
          yield* native(() =>
            db
              .prepare(
                "SELECT replaces_offer_id,disclosed_at_ms FROM consent_offers WHERE id='replacement'"
              )
              .first()
          )
        ).toEqual({ replaces_offer_id: "budget", disclosed_at_ms: null });
      }
      const invalidReference = yield* Effect.exit(
        native(() =>
          db
            .prepare(
              "INSERT INTO consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,replaces_offer_id) VALUES('after-cutover',?,'budget-threshold','p','b','{}',0,1,'reminder')"
            )
            .bind(owner)
            .run()
        )
      );
      expect(invalidReference._tag).toBe(outcome === "complete" ? "Failure" : "Success");
    })
  )
);
