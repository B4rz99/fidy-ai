import { afterAll, expect, it } from "vitest";
import { Data, Effect } from "effect";
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
  `14380000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const owner = id(1);
const originalText = ' Texto original: sí.\n{"capabilities": ["read"], "purpose": "exact bytes"} ';
const originalDisclosure = '{ "original": "sí", "missingPolicyFacts": null }';
const record = '{"evidence":"original qualified snapshot\\n","independent":true}';
const unchanged =
  "sequence,record_type,id,user_id,disclosure_message_id,decision_message_id,decision_received_at_ms,grant_record_id,session_id,withdrawal_id,grant_id,offer_id,record_json,decision,kind,pairing_id,request_id,grant_consent_id,pat_id,connection_id";
const block = (guide: string, name: string): ReadonlyArray<string> => {
  const value = guide.match(
    new RegExp(
      `<!-- ${name}:start -->\\s*\x60\x60\x60sql\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- ${name}:end -->`,
      "u"
    )
  )?.[1];
  if (value === undefined) throw Error("Missing documented Consent history cutover");
  return value
    .split(";")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
};
const objects = (source: string): ReadonlyArray<string> =>
  source
    .split("--> statement-breakpoint")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
const name = (sql: string): string =>
  /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER|VIEW) "?(\w+)"?/u.exec(sql)?.[1] ?? "";
const dependents = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source.filter(
    (sql) =>
      /^CREATE (?:UNIQUE )?(?:INDEX|TRIGGER|VIEW) /u.test(sql) && /\bconsent_history\b/u.test(sql)
  );
const dropTriggers = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source
    .filter((sql) => sql.startsWith("CREATE TRIGGER "))
    .map((sql) => `DROP TRIGGER ${name(sql)}`);

const seed = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[owner, id(2)].map((user) =>
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
        )
        .bind(user, current)
    ),
    db
      .prepare(
        "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,'BCDF-GHJK',zeroblob(32),?,'consumed',?,?)"
      )
      .bind(id(3), owner, current, current + 600000),
    db
      .prepare(
        "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,zeroblob(32),?,?,?,?)"
      )
      .bind(
        id(3),
        id(3),
        owner,
        current,
        current + 600000,
        current + 3600000,
        current + 7776000000
      ),
    ...[4, 6].map((ordinal) =>
      db
        .prepare(
          "INSERT INTO pat_pairings(id,public_code,proof_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,expires_at_ms,state,user_id,approved_at_ms,pat_expires_at_ms) VALUES(?,?,zeroblob(32),'original client','[\"read\"]',7,?,?,'approved_awaiting_claim',?,?,?)"
        )
        .bind(
          id(ordinal),
          `BCDF-${ordinal}`,
          current,
          current + 600000,
          owner,
          current,
          current + 604800000
        )
    ),
    db
      .prepare(
        "INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms) VALUES(?,?,?,'original client','Unverified name','https://example.com/cb','https://api.fidyapp.com/mcp','[\"read\"]',?,?)"
      )
      .bind(id(5), id(5), owner, current, current + 604800000),
    ...[
      { ordinal: 7, kind: "weekly-summary", time: current + 1 },
      { ordinal: 8, kind: "budget-threshold", time: null },
    ].map(({ ordinal, kind, time }) =>
      db
        .prepare(
          "INSERT INTO consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,disclosure_message_id,disclosed_at_ms) VALUES(?,?,?,'original-portfolio','original-recipient','{}',?,?,?,?)"
        )
        .bind(id(ordinal), owner, kind, current, current + 600000, `message-${ordinal}`, time)
    ),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES(7,'processing_grant',?,?,?,'disclosure','decision',?,?)"
      )
      .bind(id(11), owner, originalDisclosure, current + 9, current),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES(13,'processing_withdrawal',?,?,?,?,?)"
      )
      .bind(id(12), owner, id(11), id(3), current + 1),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,withdrawal_id,grant_record_id,session_id,disclosure_json,accepted_at_ms) VALUES(17,'processing_renewal',?,?,?,?,?,?,?)"
      )
      .bind(id(14), owner, id(12), id(11), id(3), originalDisclosure, current + 2),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,offer_id,record_json,occurred_at_ms) VALUES(23,'weekly_grant',?,?,?,?,?)"
      )
      .bind(id(15), owner, id(7), record, current + 3),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,offer_id,decision_message_id,decision) VALUES(29,'weekly_rejection',?,?,?,'weekly-no','revoke')"
      )
      .bind(id(16), owner, id(7)),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,grant_id,offer_id,decision_message_id,decision,record_json,occurred_at_ms) VALUES(31,'weekly_revocation',?,?,?,?,'weekly-revoke','revoke',?,?)"
      )
      .bind(id(17), owner, id(15), id(7), record, current + 4),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,kind,offer_id,decision_message_id,record_json,occurred_at_ms) VALUES(37,'proactivity_grant',?,?,'budget-threshold',?,'proactive-accept',?,?)"
      )
      .bind(id(18), owner, id(8), record, current + 5),
    ...[
      { sequence: 41, ordinal: 19, pair: 4 },
      { sequence: 47, ordinal: 21, pair: 6 },
    ].map(({ sequence, ordinal, pair }) =>
      db
        .prepare(
          "INSERT INTO consent_history(sequence,record_type,id,user_id,session_id,pairing_id,disclosure_revision,disclosure_text,accepted_at_ms) VALUES(?,'pat_grant',?,?,?,?,'original-revision',?,?)"
        )
        .bind(sequence, id(ordinal), owner, id(3), id(pair), originalText, current + 6)
    ),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,grant_consent_id,pairing_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms) VALUES(43,'pat_revocation',?,?,?,?,'pat-approved-unclaimed-expiry','original-revision',?,?)"
      )
      .bind(id(20), owner, id(19), id(4), originalText, current + 7),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,grant_consent_id,pairing_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms) VALUES(53,'pat_revocation',?,?,?,?,?,'original-revision',?,?)"
      )
      .bind(id(22), owner, id(21), id(6), id(3), originalText, current + 8),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,connection_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms) VALUES(59,'oauth_grant',?,?,?,?,'original-revision',?,?)"
      )
      .bind(id(23), owner, id(5), id(3), originalText, current + 10),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,connection_id,reason,occurred_at_ms) VALUES(61,'oauth_replay_revocation',?,?,?,'refresh_replay',?)"
      )
      .bind(id(24), owner, id(5), current + 11),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,user_id,connection_id,session_id,reason,disclosure_revision,disclosure_text,occurred_at_ms) VALUES(67,'oauth_user_revocation',?,?,?,'user_one','original-revision',?,?)"
      )
      .bind(owner, id(5), id(3), originalText, current + 12),
    db
      .prepare(
        "INSERT INTO consent_history(sequence,record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES(73,'processing_grant',?,?,?,'other-disclosure','other-decision',?,?)"
      )
      .bind(id(25), id(2), originalDisclosure, current + 14, current + 13),
    db
      .prepare(
        "INSERT INTO schedules(kind,id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id) VALUES('reminder',?,?,1,1,'{}','2027-01-16T00:00:00Z',?)"
      )
      .bind(id(26), owner, id(18)),
    db.prepare("UPDATE sqlite_sequence SET seq=101 WHERE name='consent_history'"),
    db
      .prepare(
        "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('historical','removed-user',?,'Complete')"
      )
      .bind(current),
    db.prepare(
      "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('historical','pat_grant_consents','initial:41','{\"disclosure_text\":\"original archive bytes\"}',1)"
    ),
  ]);

const retained = (db: D1Database): Effect.Effect<ReadonlyArray<D1Result>, FixtureFailure> =>
  native(() =>
    db.batch([
      db.prepare(`SELECT ${unchanged} FROM consent_history ORDER BY sequence`),
      db.prepare("SELECT rowid,* FROM users ORDER BY rowid"),
      db.prepare("SELECT rowid,* FROM consent_offers ORDER BY rowid"),
      db.prepare("SELECT * FROM erasure_archives ORDER BY rowid"),
      db.prepare("SELECT * FROM web_sessions ORDER BY id"),
      db.prepare("SELECT * FROM schedules ORDER BY id"),
    ])
  );

type CutoverCase =
  | Readonly<{ outcome: "complete"; _tag: "Complete" }>
  | Readonly<{ outcome: string; _tag: "Source" | "BeforeVerify" | "AfterVerify"; sql: string }>;

const orphan =
  "INSERT INTO consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES('orphan','missing-user','p','b','{}',0,1)";
const cases: ReadonlyArray<CutoverCase> = [
  { outcome: "complete", _tag: "Complete" },
  {
    outcome: "interrupted",
    _tag: "BeforeVerify",
    sql: "INSERT INTO sql_assertions(scope,accepted) VALUES('consent_history_cutover',0)",
  },
  { outcome: "broken_final_fk", _tag: "BeforeVerify", sql: orphan },
  { outcome: "broken_after_verify", _tag: "AfterVerify", sql: orphan },
  {
    outcome: "conflicting_time",
    _tag: "Source",
    sql: "UPDATE consent_history SET occurred_at_ms=accepted_at_ms+1 WHERE sequence=7",
  },
  {
    outcome: "conflicting_disclosure",
    _tag: "Source",
    sql: "UPDATE consent_history SET disclosure_json='{}' WHERE sequence=59",
  },
  {
    outcome: "conflicting_reason",
    _tag: "Source",
    sql: "UPDATE consent_history SET reason='different-original-reason' WHERE sequence=43",
  },
  {
    outcome: "unmapped_timestamp",
    _tag: "Source",
    sql: "UPDATE consent_history SET accepted_at_ms=1 WHERE sequence=29",
  },
  {
    outcome: "malformed_json",
    _tag: "Source",
    sql: "UPDATE consent_history SET disclosure_json='not JSON' WHERE sequence=7",
  },
];
const historyTable = (source: ReadonlyArray<string>): string => {
  const table = source.find((sql) => sql.startsWith('CREATE TABLE "consent_history"'));
  if (table === undefined) throw Error("Missing Consent history definition");
  return table;
};

it.each(cases)(
  "preserves original Consent evidence through a $outcome normalized-history cutover",
  (fixture) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const outcome = fixture.outcome;
        const db = yield* native(() => databases.acquire());
        yield* native(() => installTestSchema({ db }));
        const baseline = objects(
          yield* native(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const source = objects(
          yield* native(() =>
            Bun.file(new URL("./history-before-1438.fixture.sql", import.meta.url)).text()
          )
        );
        const affected = dependents(baseline);
        const oldObjects = affected.map(
          (sql) => source.find((original) => name(original) === name(sql)) ?? sql
        );
        const sourceTable = historyTable(source);
        const targetTable = historyTable(baseline);
        yield* native(() =>
          db.batch(
            [
              "PRAGMA defer_foreign_keys=ON",
              ...dropTriggers(affected),
              "DROP TABLE consent_history",
              sourceTable,
              ...oldObjects,
            ].map((sql) => db.prepare(sql))
          )
        );
        yield* native(() => seed(db));
        if (fixture._tag === "Source") {
          yield* native(() =>
            db.batch([
              db.prepare("PRAGMA ignore_check_constraints=ON"),
              db.prepare("DROP TRIGGER consent_history_no_update"),
              db.prepare(fixture.sql),
              db.prepare("PRAGMA ignore_check_constraints=OFF"),
              db.prepare(
                "CREATE TRIGGER consent_history_no_update BEFORE UPDATE ON consent_history BEGIN SELECT RAISE(ABORT,'consent_history_immutable'); END"
              ),
            ])
          );
        }
        const before = yield* retained(db);
        const oldHistory = yield* native(() =>
          db.prepare("SELECT * FROM consent_history ORDER BY sequence").all()
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
                "PRAGMA defer_foreign_keys=ON",
                ...block(guide, "consent-history-preflight"),
                ...dropTriggers(affected),
                targetTable.replace(
                  'CREATE TABLE "consent_history"',
                  "CREATE TABLE consent_history_next"
                ),
                ...block(guide, "consent-history-copy"),
                ...block(guide, "consent-history-swap"),
                ...affected,
                ...(fixture._tag === "BeforeVerify" ? [fixture.sql] : []),
                ...block(guide, "consent-history-verify"),
                ...(fixture._tag === "AfterVerify" ? [fixture.sql] : []),
              ].map((sql) => db.prepare(sql))
            )
          )
        );
        if (outcome === "complete" && result._tag === "Failure") {
          return yield* Effect.failCause(result.cause);
        }
        expect(result._tag).toBe(outcome === "complete" ? "Success" : "Failure");
        expect((yield* retained(db)).map((value) => value.results)).toEqual(
          before.map((value) => value.results)
        );
        if (outcome !== "complete") {
          expect(
            (yield* native(() =>
              db.prepare("SELECT * FROM consent_history ORDER BY sequence").all()
            )).results
          ).toEqual(oldHistory.results);
          expect(
            yield* native(() =>
              db.prepare("SELECT seq FROM sqlite_sequence WHERE name='consent_history'").first()
            )
          ).toEqual({ seq: 101 });
          expect(
            (yield* Effect.exit(
              native(() =>
                db.prepare("UPDATE consent_history SET user_id=user_id WHERE sequence=7").run()
              )
            ))._tag
          ).toBe("Failure");
          return;
        }
        expect(
          yield* native(() =>
            db
              .prepare(
                "SELECT occurred_at_ms,decision_received_at_ms,disclosure_json FROM consent_history WHERE sequence=7"
              )
              .first()
          )
        ).toEqual({
          occurred_at_ms: current,
          decision_received_at_ms: current + 9,
          disclosure_json: originalDisclosure,
        });
        expect(
          yield* native(() =>
            db.prepare("SELECT occurred_at_ms FROM consent_history WHERE sequence=29").first()
          )
        ).toEqual({ occurred_at_ms: null });
        expect(
          yield* native(() =>
            db
              .prepare(
                "SELECT id,reason,json_extract(disclosure_json,'$.revision') AS revision,json_extract(disclosure_json,'$.text') AS text FROM consent_history WHERE sequence=67"
              )
              .first()
          )
        ).toEqual({
          id: null,
          reason: "user_one",
          revision: "original-revision",
          text: originalText,
        });
        expect(
          (yield* native(() =>
            db
              .prepare(
                "SELECT session_id,reason FROM consent_history WHERE record_type='pat_revocation' ORDER BY sequence"
              )
              .all()
          )).results
        ).toEqual([
          { session_id: null, reason: "pat-approved-unclaimed-expiry" },
          { session_id: id(3), reason: null },
        ]);
        expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
        yield* native(() =>
          db
            .prepare(
              "INSERT INTO consent_history(record_type,id,user_id,offer_id,decision_message_id,decision) VALUES('weekly_rejection','after-cutover',?,?,'after-choice','decline')"
            )
            .bind(owner, id(7))
            .run()
        );
        expect(
          yield* native(() =>
            db.prepare("SELECT sequence FROM consent_history WHERE id='after-cutover'").first()
          )
        ).toEqual({ sequence: 102 });
        for (const sql of [
          "UPDATE consent_history SET reason='changed' WHERE sequence=43",
          "DELETE FROM consent_history WHERE sequence=43",
        ]) {
          expect((yield* Effect.exit(native(() => db.prepare(sql).run())))._tag).toBe("Failure");
        }
      })
    )
);
