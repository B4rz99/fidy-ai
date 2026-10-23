import {
  installHistoricalErasureChunk,
  installHistoricalErasureStorage,
} from "../schema-cutover.test-fixture";
import { afterAll, expect, it } from "vitest";
import { Cause, Data, Effect, Option } from "effect";
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
const disclosure = ' { "revision": "original", "text": "Sí, autorización exacta" } ';
const id = (ordinal: number): string =>
  `14390000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const objects = (source: string): ReadonlyArray<string> =>
  source
    .split("--> statement-breakpoint")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
const name = (sql: string): string =>
  /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER|VIEW) "?(\w+)"?/u.exec(sql)?.[1] ?? "";
const affected = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source.filter(
    (sql) =>
      (/^CREATE (?:TRIGGER|VIEW) /u.test(sql) ||
        /^CREATE (?:UNIQUE )?INDEX .* ON pending_consent_exchanges\b/u.test(sql)) &&
      /\b(pending_consent_exchanges|whatsapp_provider_handoffs|provider_authentication_attempts)\b/u.test(
        sql
      )
  );
const drop = (source: ReadonlyArray<string>): ReadonlyArray<string> =>
  source
    .filter((sql) => /^CREATE (?:TRIGGER|VIEW) /u.test(sql))
    .map((sql) => `DROP ${sql.startsWith("CREATE TRIGGER") ? "TRIGGER" : "VIEW"} ${name(sql)}`);
const table = (source: ReadonlyArray<string>): string => {
  const found = source.find((sql) => sql.startsWith("CREATE TABLE pending_consent_exchanges"));
  if (found === undefined) throw Error("Missing pre-User Consent definition");
  return found;
};
const block = (guide: string, section: string): ReadonlyArray<string> => {
  const value = guide.match(
    new RegExp(
      `<!-- consent-exchanges-${section}:start -->\\s*\x60\x60\x60sql\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- consent-exchanges-${section}:end -->`,
      "u"
    )
  )?.[1];
  if (value === undefined) throw Error("Missing documented pre-User Consent cutover");
  return value
    .split(";")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0);
};
const seed = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[1, 2, 3, 4, 5, 9].map((ordinal) =>
      db
        .prepare(`INSERT INTO pending_consent_exchanges
    (rowid,id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,correlation_token,
      disclosure_json,created_at_ms,expires_at_ms,state,sandbox_phone)
    VALUES(?,?,'portfolio',?,'123456789',?,?, ?,?,?,?,'awaiting_delivery',?)`)
        .bind(
          ordinal * 7,
          id(ordinal),
          `recipient-${ordinal}`,
          `first-${ordinal}`,
          "a".repeat(64),
          id(ordinal),
          disclosure,
          current,
          current + 86400000,
          ordinal === 5 ? "+573001234567" : null
        )
    ),
    db
      .prepare(
        "UPDATE pending_consent_exchanges SET state='outbound_started',disclosure_message_id='disclosed' WHERE id IN (?,?,?)"
      )
      .bind(id(2), id(3), id(9)),
    ...[2, 3, 9].map((ordinal) =>
      db
        .prepare(`UPDATE pending_consent_exchanges SET delivery_phone_number_id='123456789',delivery_message_id='disclosed',
    delivery_occurred_at_ms=?,delivery_received_at_ms=?,delivery_not_before_ms=? WHERE id=?`)
        .bind(current + 1000, current + 2010, current + 5010, id(ordinal))
    ),
    ...[3, 9].map((ordinal) =>
      db
        .prepare(`UPDATE pending_consent_exchanges SET decision_portfolio_id=portfolio_id,decision_bsuid=bsuid,
    decision_phone_number_id=phone_number_id,decision_disclosure_json=disclosure_json,decision_disclosure_message_id=disclosure_message_id,
    decision_value=?,decision_message_id=?,decision_delivery_key=?,decision_body_sha256=?,decision_occurred_at_ms=?,decision_received_at_ms=? WHERE id=?`)
        .bind(
          ordinal === 3 ? "accepted" : "declined",
          `decision-${ordinal}`,
          `key-${ordinal}`,
          "b".repeat(64),
          current + 6000,
          current + 6017,
          id(ordinal)
        )
    ),
    db
      .prepare(
        "UPDATE pending_consent_exchanges SET state='outbound_started',rejected_at_ms=? WHERE id=?"
      )
      .bind(current + 8000, id(4)),
    db
      .prepare(
        `INSERT INTO whatsapp_provider_handoffs(rowid,id,exchange_id,created_at_ms,expires_at_ms) VALUES(101,?,?,?,?)`
      )
      .bind(id(6), id(3), current + 6017, current + 606017),
    db
      .prepare(
        `INSERT INTO browser_login_pairings(id,public_code,verifier_digest,state,created_at_ms,expires_at_ms) VALUES(?,'BCDF-GHJK',zeroblob(32),'pending_approval',?,?)`
      )
      .bind(id(7), current, current + 600000),
    db.prepare("UPDATE whatsapp_provider_handoffs SET pairing_id=? WHERE id=?").bind(id(7), id(6)),
    db
      .prepare(`INSERT INTO provider_authentication_attempts(rowid,id,pairing_id,cookie_digest,nonce,intent,disclosure_json,consent_at_ms,created_at_ms,expires_at_ms,state,handoff_id)
    VALUES(103,?,?,zeroblob(32),'original-nonce','signup',?,?,?,?, 'pending',?)`)
      .bind(id(8), id(7), disclosure, current + 6000, current + 6017, current + 600000, id(6)),
    db
      .prepare(
        "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',?,'Complete')"
      )
      .bind(current),
    db.prepare(
      `INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','pending_consent_exchanges','initial:1','{"decision_disclosure_json":"original"}',1)`
    ),
  ]);
const retained = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    db.prepare("SELECT rowid,* FROM whatsapp_provider_handoffs ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM provider_authentication_attempts ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM erasure_archives ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM browser_login_pairings ORDER BY rowid"),
  ]);
type CutoverCase =
  | Readonly<{ _tag: "Complete"; outcome: "complete" }>
  | Readonly<{ _tag: "Source" | "BeforeVerify" | "AfterVerify"; outcome: string; sql: string }>;
const cases: ReadonlyArray<CutoverCase> = [
  { _tag: "Complete", outcome: "complete" },
  ...[
    "decision_portfolio_id",
    "decision_bsuid",
    "decision_phone_number_id",
    "decision_disclosure_json",
    "decision_disclosure_message_id",
  ].flatMap((field) => [
    {
      _tag: "Source",
      outcome: `conflicting_${field}`,
      sql: `UPDATE pending_consent_exchanges SET ${field}='different' WHERE decision_value IS NOT NULL`,
    } as const,
    {
      _tag: "Source",
      outcome: `missing_${field}`,
      sql: `UPDATE pending_consent_exchanges SET ${field}=NULL WHERE decision_value IS NOT NULL`,
    } as const,
  ]),
  {
    _tag: "Source",
    outcome: "unexplained_absent_decision_snapshot",
    sql: "UPDATE pending_consent_exchanges SET decision_disclosure_json='{}' WHERE id='14390000-0000-4000-8000-000000000001'",
  },
  {
    _tag: "BeforeVerify",
    outcome: "interrupted_after_swap",
    sql: "INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)",
  },
  {
    _tag: "BeforeVerify",
    outcome: "invalid_final_reference",
    sql: "INSERT INTO provider_credentials(issuer,subject,user_id,established_at_ms) VALUES('probe','probe','missing',0)",
  },
  {
    _tag: "AfterVerify",
    outcome: "invalid_after_checking_resumes",
    sql: "INSERT INTO provider_credentials(issuer,subject,user_id,established_at_ms) VALUES('probe','probe','missing',0)",
  },
];
const assertCutoverFailure = (cause: Cause.Cause<FixtureFailure>, outcome: string): void => {
  const failure = Cause.findErrorOption(cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isSome(failure)) {
    expect(String(failure.value.cause)).toContain(
      outcome === "invalid_after_checking_resumes"
        ? "FOREIGN KEY constraint failed"
        : "CHECK constraint failed: accepted = 1"
    );
  }
};
it.each(cases)("preserves original onboarding proof through a $outcome cutover", (fixture) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() => installHistoricalErasureStorage(db));
      yield* native(() => installHistoricalErasureChunk(db));
      const baseline = objects(
        yield* native(() =>
          Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
        )
      );
      const source = objects(
        yield* native(() =>
          Bun.file(new URL("./exchanges-before-1439.fixture.sql", import.meta.url)).text()
        )
      );
      const dependents = affected(baseline);
      const originals = dependents
        .filter((sql) => name(sql) !== "pending_consent_exchange_basis_immutable")
        .map((sql) => source.find((old) => name(old) === name(sql)) ?? sql);
      yield* native(() =>
        db.batch(
          [
            "PRAGMA defer_foreign_keys=ON",
            ...drop(dependents),
            "DROP TABLE pending_consent_exchanges",
            table(source),
            ...originals,
          ].map((sql) => db.prepare(sql))
        )
      );
      yield* native(() => seed(db));
      if (fixture._tag === "Source") {
        yield* native(() =>
          db.batch(
            [
              "PRAGMA ignore_check_constraints=ON",
              "DROP TRIGGER pending_consent_decisions_no_update",
              fixture.sql,
              "PRAGMA ignore_check_constraints=OFF",
              ...originals.filter((sql) => name(sql) === "pending_consent_decisions_no_update"),
            ].map((sql) => db.prepare(sql))
          )
        );
      }
      const before = yield* native(() =>
        db.prepare("SELECT rowid,* FROM pending_consent_exchanges ORDER BY rowid").all()
      );
      const companions = yield* native(() => retained(db));
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
              ...block(guide, "preflight"),
              ...drop(originals),
              table(baseline).replace(
                "CREATE TABLE pending_consent_exchanges",
                "CREATE TABLE pending_consent_exchanges_next"
              ),
              ...block(guide, "copy"),
              ...block(guide, "swap"),
              ...dependents,
              ...(fixture._tag === "BeforeVerify" ? [fixture.sql] : []),
              ...block(guide, "verify"),
              ...(fixture._tag === "AfterVerify" ? [fixture.sql] : []),
            ].map((sql) => db.prepare(sql))
          )
        )
      );
      if (fixture._tag === "Complete" && result._tag === "Failure") {
        return yield* Effect.failCause(result.cause);
      }
      expect(result._tag).toBe(fixture._tag === "Complete" ? "Success" : "Failure");
      if (result._tag === "Failure") assertCutoverFailure(result.cause, fixture.outcome);
      expect((yield* native(() => retained(db))).map((value) => value.results)).toEqual(
        companions.map((value) => value.results)
      );
      const after = yield* native(() =>
        db
          .prepare(
            fixture._tag === "Complete"
              ? `SELECT rowid,*,
    CASE WHEN decision_value IS NOT NULL THEN portfolio_id END AS decision_portfolio_id,
    CASE WHEN decision_value IS NOT NULL THEN bsuid END AS decision_bsuid,
    CASE WHEN decision_value IS NOT NULL THEN phone_number_id END AS decision_phone_number_id,
    CASE WHEN decision_value IS NOT NULL THEN disclosure_json END AS decision_disclosure_json,
    CASE WHEN decision_value IS NOT NULL THEN disclosure_message_id END AS decision_disclosure_message_id
    FROM pending_consent_exchanges ORDER BY rowid`
              : "SELECT rowid,* FROM pending_consent_exchanges ORDER BY rowid"
          )
          .all()
      );
      expect(after.results).toEqual(before.results);
      expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        []
      );
      if (fixture._tag !== "Complete") return;
      for (const mutation of [
        "portfolio_id='changed'",
        "disclosure_json='{}'",
        "disclosure_message_id='changed'",
        "decision_value=NULL,decision_message_id=NULL,decision_delivery_key=NULL,decision_body_sha256=NULL,decision_occurred_at_ms=NULL,decision_received_at_ms=NULL",
      ]) {
        expect(
          (yield* Effect.exit(
            native(() =>
              db
                .prepare(
                  `UPDATE pending_consent_exchanges SET ${mutation} WHERE decision_value IS NOT NULL`
                )
                .run()
            )
          ))._tag
        ).toBe("Failure");
      }
    })
  )
);
