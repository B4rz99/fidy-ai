import { installHistoricalErasureChunk } from "../../schema-cutover.test-fixture";
import { afterAll, expect, it } from "vitest";
import { Data, Effect } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../../d1-test-fixture";
import { makeAuditRetention } from "../../../src/shell/audit/runtime";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new FixtureFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14360000-0000-4000-8000-000000000001";
const foreign = "14360000-0000-4000-8000-000000000002";
const history = "14360000-0000-4000-8000-000000000003";
const current = 1_800_000_000_000;
const lifetime = 365 * 86400000;
const originalGuards: ReadonlyArray<string> = [
  "CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries\nWHEN OLD.record_type IN ('session_call','credential_call','insight_call','publication')\n AND NOT EXISTS (\n  SELECT 1 FROM (SELECT rowid,id AS user_id,audit_retention_cutoff_ms AS cutoff_ms FROM users WHERE audit_retention_cutoff_ms IS NOT NULL) WHERE user_id=OLD.user_id AND OLD.occurred_at_ms<cutoff_ms\n )\n AND NOT EXISTS (\n  SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id\n  WHERE p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id\n  AND p.store_id=CASE OLD.record_type\n WHEN 'session_call' THEN 'session_audit'\n WHEN 'credential_call' THEN 'pat_audit'\n WHEN 'insight_call' THEN 'insight_audit'\n WHEN 'publication' THEN 'ingestion_publication_audit'\n WHEN 'media_admission' THEN 'media_submission_audit'\n WHEN 'billing_transition' THEN 'billing_audit'\n WHEN 'request_admission' THEN 'canonical_request_acceptances'\n WHEN 'identity_read' THEN 'canonical_user_reads'\n WHEN 'security_mutation' THEN 'canonical_security_mutations'\n WHEN 'oauth_refresh' THEN 'oauth_refresh_events'\n WHEN 'support_recovery' THEN 'support_recovery_events'\n WHEN 'reminder_control' THEN 'reminder_control_receipts'\n END\n )\nBEGIN SELECT RAISE(ABORT,'audit_append_only'); END;",
  "CREATE TRIGGER erasure_fence_audit_retention_permits_delete BEFORE DELETE ON users WHEN (OLD.audit_retention_cutoff_ms IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;",
  "CREATE TRIGGER erasure_fence_audit_retention_permits_insert BEFORE INSERT ON users WHEN (NEW.audit_retention_cutoff_ms IS NOT NULL) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;",
  "CREATE TRIGGER erasure_fence_audit_retention_permits_update BEFORE UPDATE ON users WHEN ((NEW.id IS NOT OLD.id OR NEW.audit_retention_cutoff_ms IS NOT OLD.audit_retention_cutoff_ms) AND (OLD.audit_retention_cutoff_ms IS NOT NULL OR NEW.audit_retention_cutoff_ms IS NOT NULL)) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.id=q.user_id) OR (OLD.id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;",
  "CREATE TRIGGER erasure_preserve_audit_retention_permits_delete BEFORE DELETE ON users WHEN (OLD.audit_retention_cutoff_ms IS NOT NULL) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)\n  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'\n  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)\nBEGIN\n  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)\n  SELECT q.id,'audit_retention_permits','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'cutoff_ms',OLD.audit_retention_cutoff_ms)\n  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)\n    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'\n    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;\nEND;",
  "CREATE TRIGGER erasure_preserve_audit_retention_permits_delete_clear BEFORE UPDATE ON users WHEN (OLD.audit_retention_cutoff_ms IS NOT NULL) AND NEW.audit_retention_cutoff_ms IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)\n  AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'\n  AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000)\nBEGIN\n  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)\n  SELECT q.id,'audit_retention_permits','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD.id,'cutoff_ms',OLD.audit_retention_cutoff_ms)\n  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.id=q.user_id)\n    AND json_extract(q.decision_json,'$.dispositions.audit.action')='Retain'\n    AND json_extract(q.decision_json,'$.dispositions.audit.retention.untilMs')>unixepoch('subsec')*1000;\nEND;",
];

const block = (guide: string, name: string): ReadonlyArray<string> => {
  const sql = guide.match(
    new RegExp(
      `<!-- ${name}:start -->\\s*\x60\x60\x60sql\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- ${name}:end -->`,
      "u"
    )
  )?.[1];
  if (sql === undefined) throw Error("Missing documented Audit permit cutover");
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

it.each(["complete", "interrupted", "retained_permit", "unfinished_chunk"] as const)(
  "preserves User, Audit and archive history through a %s retention permit cutover",
  (outcome) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* native(() => databases.acquire());
        yield* native(() => installTestSchema({ db }));
        yield* native(() => installHistoricalErasureChunk(db));
        const baseline = yield* native(() =>
          Bun.file(new URL("../../migrations/0001_schema.sql", import.meta.url)).text()
        );
        const objects = baseline.split("--> statement-breakpoint").map((sql) => sql.trim());
        const target = objects.filter(
          (sql) =>
            /\b(?:TABLE|ON) audit_retention_permits\b/u.test(sql) ||
            sql.startsWith("CREATE TRIGGER audit_entries_no_delete ")
        );
        yield* native(() =>
          db.batch([
            db.prepare("DROP TRIGGER audit_entries_no_delete"),
            db.prepare("DROP TABLE audit_retention_permits"),
            db.prepare("ALTER TABLE users ADD COLUMN audit_retention_cutoff_ms INTEGER"),
            ...originalGuards.map((sql) => db.prepare(sql)),
            ...[
              { id: owner, rowid: 7 },
              { id: foreign, rowid: 101 },
            ].map(({ id, rowid }) =>
              db
                .prepare(
                  "INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms) VALUES(?,?,'CO','es-CO','America/Bogota',?)"
                )
                .bind(rowid, id, current)
            ),
            ...[owner, foreign].flatMap((id) => [
              db
                .prepare(
                  "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,zeroblob(32),?,'consumed',?,?)"
                )
                .bind(id, id === owner ? "BCDF-GHJK" : "BCDF-GHJL", id, current, current + 600000),
              db
                .prepare(
                  "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,?,?,?,?,?)"
                )
                .bind(
                  id,
                  id,
                  id,
                  new Uint8Array(32).fill(id === owner ? 1 : 2),
                  current,
                  current + 600000,
                  current + 86400000,
                  current + 7776000000
                ),
              db
                .prepare(
                  "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES(?,'session_call',?,?,?,'transactions.listTransactions','success',?)"
                )
                .bind(id === owner ? 7 : 101, id, id, id, current - 1),
            ]),
            db
              .prepare(
                "INSERT INTO audit_entries(record_type,id,user_id,session_id,occurred_at_ms) VALUES('identity_read',?,?,?,?)"
              )
              .bind(history, owner, owner, current - 1),
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,?,'Complete')"
              )
              .bind(history, history, current),
            db
              .prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES(?,'audit_retention_permits','initial:700',?,1)"
              )
              .bind(history, '{"user_id":"historical","cutoff_ms":123}'),
          ])
        );
        if (outcome === "retained_permit") {
          yield* native(() =>
            db.prepare("UPDATE users SET audit_retention_cutoff_ms=0 WHERE id=?").bind(owner).run()
          );
        }
        if (outcome === "unfinished_chunk") {
          yield* native(() =>
            db
              .prepare("INSERT INTO erasure_chunk(request_id,row_ref) VALUES(?,'7')")
              .bind(history)
              .run()
          );
        }
        const users = yield* native(() =>
          db.prepare("SELECT rowid,* FROM users ORDER BY rowid").all()
        );
        const audit = yield* native(() =>
          db.prepare("SELECT * FROM audit_entries ORDER BY sequence").all()
        );
        const sessions = yield* native(() =>
          db.prepare("SELECT * FROM web_sessions ORDER BY id").all()
        );
        const archives = yield* native(() => db.prepare("SELECT * FROM erasure_archives").all());
        const guide = yield* native(() =>
          Bun.file(
            new URL("../../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const statements = [
          ...target.filter((sql) => sql.startsWith("CREATE TABLE")),
          ...block(guide, "audit-retention-permit-cutover"),
          ...(outcome === "interrupted"
            ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('audit_retention_cutover',0)"]
            : []),
          ...target.filter((sql) => !sql.startsWith("CREATE TABLE")),
          ...block(guide, "audit-retention-permit-verify"),
        ];
        const commit = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(statements.map((sql) => db.prepare(sql)));
        if (outcome !== "complete") {
          yield* native(() => expect(commit()).rejects.toThrow());
          expect(
            (yield* native(() => db.prepare("SELECT rowid,* FROM users ORDER BY rowid").all()))
              .results
          ).toEqual(users.results);
        } else {
          yield* native(() => commit());
          const expectedUsers = users.results.map(
            ({ audit_retention_cutoff_ms: _discarded, ...retained }) => retained
          );
          expect(
            (yield* native(() => db.prepare("SELECT rowid,* FROM users ORDER BY rowid").all()))
              .results
          ).toEqual(expectedUsers);
        }
        expect(
          (yield* native(() => db.prepare("SELECT * FROM audit_entries ORDER BY sequence").all()))
            .results
        ).toEqual(audit.results);
        expect(
          (yield* native(() => db.prepare("SELECT * FROM web_sessions ORDER BY id").all())).results
        ).toEqual(sessions.results);
        expect(
          (yield* native(() => db.prepare("SELECT * FROM erasure_archives").all())).results
        ).toEqual(archives.results);
        if (outcome === "complete") {
          const retention = makeAuditRetention({ database: db });
          expect(yield* retention.retain({ userId: owner, now: current + lifetime })).toBe(1);
          expect(
            (yield* native(() =>
              db
                .prepare(
                  "SELECT record_type,user_id,occurred_at_ms FROM audit_entries ORDER BY sequence"
                )
                .all()
            )).results
          ).toEqual([
            { record_type: "session_call", user_id: foreign, occurred_at_ms: current - 1 },
            { record_type: "identity_read", user_id: owner, occurred_at_ms: current - 1 },
          ]);
          expect(
            (yield* native(() => db.prepare("SELECT user_id FROM audit_retention_permits").all()))
              .results
          ).toEqual([]);
        }
      })
    )
);
