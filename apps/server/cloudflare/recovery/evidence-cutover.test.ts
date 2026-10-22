import { afterAll, expect, it } from "vitest";
import { Cause, Data, Effect, Option, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import {
  documentedSqlBlock,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { makeRecoveryErasureStores } from "./runtime";
import type { ErasureUnavailable } from "../erasure-store/contract";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new FixtureFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const current = 1_800_000_000_123;
const recordId = (ordinal: number): string =>
  `14420000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const owner = "14420000-0000-4000-8000-000000000001";
const foreign = "14420000-0000-4000-8000-000000000002";
const requestId = "14420000-0000-4000-8000-000000000003";
const onAudit = (sql: string): boolean =>
  /^CREATE (?:UNIQUE )?(?:TRIGGER|INDEX) .*?\bON "?audit_entries\b/su.test(sql);
const caseAdditions = (sql: string): boolean =>
  schemaObjectName(sql).startsWith("support_recovery_") &&
  schemaObjectName(sql) !== "support_recovery_cases" &&
  schemaObjectName(sql) !== "support_recovery_admissions" &&
  !/ ON support_recovery_admissions\b/u.test(sql) &&
  !["support_recovery_cases_retention", "support_recovery_cases_user"].includes(
    schemaObjectName(sql)
  );
const seed = (db: D1Database, includeEvidence: boolean): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[owner, foreign].map((id) =>
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
        )
        .bind(id)
    ),
    ...[owner, foreign].map((id, index) =>
      db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,randomblob(32),?,'consumed',?,?)"
        )
        .bind(
          recordId(10 + index),
          index === 0 ? "BCDF-GHJK" : "BCDF-HJKM",
          id,
          current - 1000,
          current + 599000
        )
    ),
    db
      .prepare(
        "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES('14420000-0000-4000-8000-000000000020','14420000-0000-4000-8000-000000000010',?,zeroblob(32),?,?,?,?)"
      )
      .bind(
        owner,
        current - 1000,
        current + 599000,
        current + 3600000,
        current - 1000 + 7776000000
      ),
    ...(includeEvidence
      ? [
          ...[owner, foreign].map((id, index) =>
            db
              .prepare(
                "INSERT INTO support_recovery_cases(rowid,id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms) VALUES(?,?,?,?,?,?,3,?,?,?,?)"
              )
              .bind(
                index === 0 ? 11 : 31,
                `case-${index}`,
                id,
                recordId(10 + index),
                "original-issuer",
                `operator-${index}`,
                current - 500,
                current + 599000,
                index === 0 ? "approved" : "rejected",
                current - 100
              )
          ),
          ...[owner, foreign].flatMap((id, index) =>
            ["opened", index === 0 ? "approved" : "rejected"].map((action, ordinal) =>
              db
                .prepare(
                  "INSERT INTO audit_entries(sequence,record_type,id,user_id,recovery_case_id,operator_issuer,operator_subject,recovery_action,occurred_at_ms) VALUES(?,'support_recovery',?,?,?,?,?,?,?)"
                )
                .bind(
                  (index + 1) * 10 + ordinal,
                  `event-${index}-${ordinal}`,
                  id,
                  `case-${index}`,
                  "original-issuer",
                  `operator-${index}`,
                  action,
                  action === "opened" ? current - 500 : current - 100
                )
            )
          ),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,occurred_at_ms) VALUES(51,'identity_read','original-read',?,'14420000-0000-4000-8000-000000000020',?)"
            )
            .bind(owner, current - 200),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES(52,'session_call','original-call',?,'14420000-0000-4000-8000-000000000020','categories.listCategories','success',?)"
            )
            .bind(owner, current - 100),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,occurred_at_ms) VALUES(53,'security_mutation','original-rotation',?,'14420000-0000-4000-8000-000000000020','recovery.rotateBackupRecoveryCode',?)"
            )
            .bind(owner, current - 100),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,operation,outcome,occurred_at_ms) VALUES(54,'publication','original-publication',?,'ingestion.submitForExtraction','success',?)"
            )
            .bind(owner, current - 100),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES(55,'insight_call','original-insight',?,'14420000-0000-4000-8000-000000000020','insights.listPendingInsights','accepted',?)"
            )
            .bind(owner, current - 100),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES(56,'credential_call','original-credential',?,'14420000-0000-4000-8000-000000000020','tokens.listTokens','accepted',?)"
            )
            .bind(owner, current - 100),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,outcome) VALUES(999,'reminder_control',json_array(?,'original-message'),?,'off')"
            )
            .bind(owner, owner),
          db.prepare("DELETE FROM audit_entries WHERE sequence=999"),
          db.prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
          ),
          db.prepare(
            "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','support_recovery_events','initial:10','{}',1)"
          ),
        ]
      : []),
  ]);
const snapshot = (db: D1Database): Promise<ReadonlyArray<D1Result<Record<string, unknown>>>> =>
  db.batch([
    db.prepare("SELECT rowid,* FROM support_recovery_cases ORDER BY rowid"),
    db.prepare("SELECT * FROM audit_entries ORDER BY sequence"),
    db.prepare("SELECT * FROM sqlite_sequence ORDER BY name"),
    db.prepare("SELECT rowid,* FROM erasure_archives ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM browser_login_pairings ORDER BY rowid"),
    db.prepare("SELECT rowid,* FROM web_sessions ORDER BY rowid"),
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
  ]);
type CutoverCase =
  | Readonly<{
      stage: "Complete";
      description: string;
      history: "Populated" | "RetainedEmpty" | "Unwritten";
    }>
  | Readonly<{ stage: "Source" | "AfterCopy" | "AfterReplace"; description: string; sql: string }>;
const cases: ReadonlyArray<CutoverCase> = [
  { stage: "Complete", description: "approved and rejected evidence", history: "Populated" },
  { stage: "Complete", description: "an empty remaining Audit log", history: "RetainedEmpty" },
  { stage: "Complete", description: "an Audit log never written to", history: "Unwritten" },
  {
    stage: "Source",
    description: "a missing opening",
    sql: "DELETE FROM audit_entries WHERE sequence=10",
  },
  {
    stage: "Source",
    description: "a missing terminal event",
    sql: "DELETE FROM audit_entries WHERE sequence=11",
  },
  {
    stage: "Source",
    description: "repeated opening evidence",
    sql: "INSERT INTO audit_entries(record_type,id,user_id,recovery_case_id,operator_issuer,operator_subject,recovery_action,occurred_at_ms) SELECT record_type,'repeated',user_id,recovery_case_id,operator_issuer,operator_subject,recovery_action,occurred_at_ms FROM audit_entries WHERE sequence=10",
  },
  {
    stage: "Source",
    description: "a different operator",
    sql: "UPDATE support_recovery_cases SET operator_subject='other-operator' WHERE id='case-0'",
  },
  {
    stage: "Source",
    description: "a different opening instant",
    sql: "UPDATE support_recovery_cases SET opened_at_ms=opened_at_ms+1 WHERE id='case-0'",
  },
  {
    stage: "Source",
    description: "a different terminal instant",
    sql: "UPDATE support_recovery_cases SET closed_at_ms=closed_at_ms+1 WHERE id='case-0'",
  },
  {
    stage: "Source",
    description: "a contradictory decision",
    sql: "UPDATE support_recovery_cases SET state='rejected' WHERE id='case-0'",
  },
  {
    stage: "Source",
    description: "foreign case ownership",
    sql: `UPDATE support_recovery_cases SET user_id='${foreign}' WHERE id='case-0'`,
  },
  {
    stage: "Source",
    description: "an unexpected incoming Audit relationship",
    sql: "CREATE TABLE sqlitex_audit_dependency(record_sequence INTEGER REFERENCES audit_entries(sequence))",
  },
  {
    stage: "AfterCopy",
    description: "an interrupted extraction",
    sql: "INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)",
  },
  {
    stage: "AfterReplace",
    description: "an interrupted Audit replacement",
    sql: "INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)",
  },
];
const inject = (
  fixture: CutoverCase,
  stage: "AfterCopy" | "AfterReplace"
): ReadonlyArray<string> => (fixture.stage === stage ? [fixture.sql] : []);
const eventMetadataErasure = (
  db: D1Database
): Effect.Effect<void, FixtureFailure | ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* native(() =>
      db.batch(
        Array.from({ length: 32 }, (_, index) => [
          db
            .prepare(
              "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,randomblob(32),?,'consumed',?,?)"
            )
            .bind(
              recordId(100 + index),
              String(index).padStart(9, "B"),
              owner,
              current - 1000,
              current + 599000
            ),
          db
            .prepare(
              "INSERT INTO support_recovery_cases(id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms,opened_event_id,opened_event_row_ref,decision_event_id,decision_event_row_ref) VALUES(?,?,?,'original-issuer','batch-operator',3,?,?,'approved',?,?,?,?,?)"
            )
            .bind(
              recordId(200 + index),
              owner,
              recordId(100 + index),
              current - 500,
              current + 599000,
              current - 100,
              `opened-${index}`,
              String(1000 + index * 2),
              `decided-${index}`,
              String(1001 + index * 2)
            ),
        ]).flat()
      )
    );
    const before = yield* native(() =>
      db.prepare("SELECT * FROM support_recovery_cases ORDER BY rowid").all()
    );
    yield* native(() =>
      expect(
        db
          .prepare(
            "INSERT INTO support_recovery_cases(id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms) SELECT 'forged',?,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms FROM support_recovery_cases WHERE id='case-0'"
          )
          .bind(foreign)
          .run()
      ).rejects.toThrow("recovery_case_owner")
    );
    yield* native(() =>
      db.batch([
        db
          .prepare(
            'INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,1,\'AwaitingReview\',\'{"dispositions":{"credentials":{"action":"Retain","retention":{"untilMs":4102444800000}}}}\')'
          )
          .bind(requestId, owner),
        db
          .prepare(
            "INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES(?,'support_recovery_events','credentials')"
          )
          .bind(requestId),
        db.prepare("UPDATE erasure_requests SET state='Archiving' WHERE id=?").bind(requestId),
      ])
    );
    const store = makeRecoveryErasureStores(db).find(
      (entry) => entry.id === "support_recovery_events"
    );
    if (store === undefined) throw Error("Missing recovery metadata erasure");
    const scope = { userId: owner, reference: requestId };
    expect(yield* store.archive(scope)).toBe(false);
    expect(yield* store.archive(scope)).toBe(true);
    const archives = yield* native(() =>
      db
        .prepare(
          "SELECT store_id,row_ref,body FROM erasure_archives WHERE request_id=? ORDER BY row_ref"
        )
        .bind(requestId)
        .all()
    );
    expect(archives.results).toHaveLength(66);
    expect(
      archives.results.filter((row) => row.row_ref === "initial:10" || row.row_ref === "initial:11")
    ).toEqual([
      { store_id: "support_recovery_events", row_ref: "initial:10", body: "{}" },
      { store_id: "support_recovery_events", row_ref: "initial:11", body: "{}" },
    ]);
    yield* native(() =>
      db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(requestId).run()
    );
    expect(
      (yield* Effect.result(store.remove({ reference: requestId, userId: foreign })))._tag
    ).toBe("Failure");
    yield* native(() =>
      expect(
        db
          .prepare(
            "UPDATE support_recovery_cases SET opened_event_id=NULL,opened_event_row_ref=NULL WHERE user_id=?"
          )
          .bind(owner)
          .run()
      ).rejects.toThrow("recovery_case_immutable")
    );
    yield* native(() =>
      expect(
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_permits(request_id,user_id,store_id) VALUES(?,?,'support_recovery_cases')"
            )
            .bind(requestId, owner),
          db.prepare("DELETE FROM support_recovery_cases WHERE user_id=?").bind(owner),
        ])
      ).rejects.toThrow("erasure_fenced")
    );
    yield* native(() =>
      db
        .prepare("INSERT INTO erasure_chunk(request_id,row_ref) VALUES(?,'20')")
        .bind(requestId)
        .run()
    );
    yield* native(() =>
      db
        .prepare(
          "CREATE TRIGGER interrupt_recovery_metadata AFTER UPDATE ON support_recovery_cases BEGIN SELECT RAISE(ABORT,'interrupted metadata removal');END"
        )
        .run()
    );
    expect((yield* Effect.result(store.remove(scope)))._tag).toBe("Failure");
    expect(
      (yield* native(() => db.prepare("SELECT * FROM support_recovery_cases ORDER BY rowid").all()))
        .results
    ).toEqual(before.results);
    yield* native(() => db.prepare("DROP TRIGGER interrupt_recovery_metadata").run());
    expect(yield* store.remove(scope)).toBe(false);
    expect(
      yield* native(() =>
        db
          .prepare(
            "SELECT sum((opened_event_id IS NOT NULL)+(decision_event_id IS NOT NULL)) AS remaining FROM support_recovery_cases WHERE user_id=?"
          )
          .bind(owner)
          .first("remaining")
      )
    ).toBe(2);
    const resumed = Option.getOrThrow(
      Option.fromUndefinedOr(
        makeRecoveryErasureStores(db).find((entry) => entry.id === "support_recovery_events")
      )
    );
    expect(yield* resumed.remove(scope)).toBe(true);
    expect(yield* resumed.remove(scope)).toBe(true);
    const after = yield* native(() =>
      db.prepare("SELECT * FROM support_recovery_cases ORDER BY rowid").all()
    );
    expect(after.results).toEqual(
      before.results.map((row) =>
        row.user_id === owner
          ? {
              ...row,
              opened_event_id: null,
              opened_event_row_ref: null,
              decision_event_id: null,
              decision_event_row_ref: null,
            }
          : row
      )
    );
    expect(
      (yield* native(() => db.prepare("SELECT * FROM erasure_permits").all())).results
    ).toEqual([]);
  });
const prepareSource = ({
  db,
  fixture,
}: Readonly<{ db: D1Database; fixture: CutoverCase }>): Effect.Effect<void, FixtureFailure> =>
  Effect.gen(function* () {
    if (fixture.stage === "Source") {
      yield* native(() => db.prepare(fixture.sql).run());
    }
    if (fixture.stage === "Complete" && fixture.history === "RetainedEmpty") {
      yield* native(() =>
        db.batch([
          db
            .prepare("INSERT INTO audit_retention_permits(user_id,cutoff_ms) VALUES(?,?)")
            .bind(owner, current + 1),
          db.prepare("DELETE FROM audit_entries WHERE record_type<>'support_recovery'"),
          db.prepare("DELETE FROM audit_retention_permits WHERE user_id=?").bind(owner),
        ])
      );
    }
  });
const referenceChecks = ({
  tables,
  guide,
}: Readonly<{ tables: ReadonlyArray<string>; guide: string }>): ReadonlyArray<string> =>
  tables.flatMap((name) =>
    documentedSqlBlock({ guide, marker: "recovery-evidence-references" }).map((statement) =>
      statement.replace("__TABLE_NAME__", name)
    )
  );
const resultRows = ({
  tables,
  index,
}: Readonly<{
  tables: ReadonlyArray<D1Result<Record<string, unknown>>>;
  index: number;
}>): ReadonlyArray<Record<string, unknown>> =>
  Option.getOrThrow(Option.fromUndefinedOr(tables[index])).results;
const planDetails = (result: D1Result): ReadonlyArray<string> =>
  Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ detail: Schema.String })))(
    result.results
  ).map((row) => row.detail);
const assertPreserved = ({
  db,
  before,
  plansBefore,
}: Readonly<{
  db: D1Database;
  before: ReadonlyArray<D1Result<Record<string, unknown>>>;
  plansBefore: D1Result;
}>): Effect.Effect<void, FixtureFailure> =>
  Effect.gen(function* () {
    const after = yield* native(() => snapshot(db));
    expect(resultRows({ tables: after, index: 0 })).toEqual(
      resultRows({ tables: before, index: 0 }).map((row, index) => ({
        ...row,
        opened_event_id: `event-${index}-0`,
        opened_event_row_ref: String((index + 1) * 10),
        decision_event_id: `event-${index}-1`,
        decision_event_row_ref: String((index + 1) * 10 + 1),
      }))
    );
    expect(resultRows({ tables: after, index: 1 })).toEqual(
      resultRows({ tables: before, index: 1 })
        .filter((row) => row.record_type !== "support_recovery")
        .map((row) => {
          const retained = { ...row };
          delete retained.recovery_case_id;
          delete retained.operator_issuer;
          delete retained.operator_subject;
          delete retained.recovery_action;
          return retained;
        })
    );
    const sourceSequences = resultRows({ tables: before, index: 2 });
    const sourceAuditSequence = sourceSequences.find((row) => row.name === "audit_entries");
    expect(resultRows({ tables: after, index: 2 })).toEqual(
      sourceAuditSequence === undefined
        ? [...sourceSequences, { name: "audit_entries", seq: 0 }].sort((left, right) =>
            String(left.name).localeCompare(String(right.name))
          )
        : sourceSequences
    );
    for (const index of [3, 4, 5]) {
      expect(resultRows({ tables: after, index })).toEqual(resultRows({ tables: before, index }));
    }
    const plansAfter = yield* native(() =>
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id,closed_at_ms FROM support_recovery_cases ORDER BY closed_at_ms,id LIMIT 32"
        )
        .all()
    );
    expect(planDetails(plansAfter)).toEqual(planDetails(plansBefore));
    yield* native(() =>
      db
        .prepare(
          "INSERT INTO audit_entries(record_type,id,user_id,session_id,occurred_at_ms) VALUES('identity_read','next-read',?,'14420000-0000-4000-8000-000000000020',?)"
        )
        .bind(owner, current)
        .run()
    );
    expect(
      yield* native(() =>
        db.prepare("SELECT sequence FROM audit_entries WHERE id='next-read'").first("sequence")
      )
    ).toBe(Number(sourceAuditSequence?.seq ?? 0) + 1);
  });
it.each(cases)("preserves recovery evidence or refuses $description atomically", (fixture) =>
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
          Bun.file(new URL("./evidence-before-1442.fixture.sql", import.meta.url)).text()
        )
      ).map((sql) => sql.replaceAll("FROM billing_attempts", "FROM billing_attempt_context"));
      const auditTarget = schemaStatements(
        yield* native(() =>
          Bun.file(
            new URL("../oauth-agents/lineage-before-1446.fixture.sql", import.meta.url)
          ).text()
        )
      );
      const auditObjects = auditTarget.filter(onAudit);
      yield* native(() =>
        db.batch(
          [
            "PRAGMA defer_foreign_keys=ON",
            "DROP TABLE audit_entries",
            "DROP TABLE support_recovery_cases",
            ...source,
          ].map((sql) => db.prepare(sql))
        )
      );
      yield* native(() =>
        seed(db, fixture.stage !== "Complete" || fixture.history !== "Unwritten")
      );
      yield* prepareSource({ db, fixture });
      const before = yield* native(() => snapshot(db));
      const tableRows = yield* native(() =>
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name<>'_cf_METADATA'"
          )
          .all()
      );
      const tableNames = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            name: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
          })
        )
      )(tableRows.results).pipe(Effect.mapError((cause) => new FixtureFailure({ cause })));
      const tables = tableNames.map((row) => row.name);
      const plansBefore = yield* native(() =>
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT id,closed_at_ms FROM support_recovery_cases ORDER BY closed_at_ms,id LIMIT 32"
          )
          .all()
      );
      const guide = yield* native(() =>
        Bun.file(
          new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
        ).text()
      );
      const sourceAuditTriggers = source.filter(
        (sql) => sql.startsWith("CREATE TRIGGER") && onAudit(sql)
      );
      const result = yield* Effect.exit(
        native(() =>
          db.batch(
            [
              ...documentedSqlBlock({ guide, marker: "recovery-evidence-preflight" }),
              ...referenceChecks({ tables, guide }),
              ...sourceAuditTriggers.map((sql) => `DROP TRIGGER ${schemaObjectName(sql)}`),
              schemaDefinition({ source: auditTarget, target: "audit_entries" }).replace(
                '"audit_entries"',
                '"audit_entries_1442"'
              ),
              ...documentedSqlBlock({ guide, marker: "recovery-evidence-copy" }),
              ...inject(fixture, "AfterCopy"),
              ...documentedSqlBlock({ guide, marker: "recovery-evidence-replace" }),
              ...auditObjects,
              "DROP TRIGGER erasure_fence_support_recovery_cases_update",
              ...baseline.filter(caseAdditions),
              schemaDefinition({
                source: baseline,
                target: "erasure_fence_support_recovery_cases_update",
              }),
              ...inject(fixture, "AfterReplace"),
              ...documentedSqlBlock({ guide, marker: "recovery-evidence-verify" }),
            ].map((sql) => db.prepare(sql))
          )
        )
      );
      if (fixture.stage === "Complete" && result._tag === "Failure") {
        return yield* Effect.failCause(result.cause);
      }
      expect(result._tag).toBe(fixture.stage === "Complete" ? "Success" : "Failure");
      if (result._tag === "Failure") {
        const error = Cause.findErrorOption(result.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(String(error.value.cause)).toContain("CHECK constraint failed: accepted = 1");
        }
        expect((yield* native(() => snapshot(db))).map((value) => value.results)).toEqual(
          before.map((value) => value.results)
        );
        return;
      }
      yield* assertPreserved({ db, before, plansBefore });
      if (fixture.stage === "Complete" && fixture.history === "Populated") {
        yield* eventMetadataErasure(db);
      }
      expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        []
      );
    })
  )
);
