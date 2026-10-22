import { makeRecoveryErasureStores } from "../recovery/runtime";
import { makeEmailAuthenticationErasureStores } from "../email-authentication/runtime";
import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { installRetentionTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { retainedReviewRows } from "./native.test-fixture";
import { sweepReviewDrafts } from "../ingestion/runtime";
import { makeMemoryErasureStores } from "../memory/runtime";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "12740000-0000-4000-8000-000000000001";
const foreignUser = "12740000-0000-4000-8000-000000000099";
const reference = "12740000-0000-4000-8000-000000000002";
const scope = { userId, reference };

it("archives reviewed Memory in bounded pages, resumes after reconstruction, and preserves the other User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const decision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        dispositions: {
          memory: {
            action: "Retain",
            retention: { untilMs: (yield* Clock.currentTimeMillis) + 86400000 },
          },
        },
      });
      const statements = [
        ...[userId, foreignUser].map((id) =>
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
            )
            .bind(id)
        ),
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,1,'AwaitingReview',?)"
          )
          .bind(reference, userId, decision),
        db
          .prepare(
            "INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES(?,'memories','memory')"
          )
          .bind(reference),
        ...Array.from({ length: 70 }, (_, index) =>
          db
            .prepare(
              "INSERT INTO memories VALUES(?,?,'Contexto económico','2026-10-15','2026-10-15')"
            )
            .bind(`memory-${index}`, userId)
        ),
        db
          .prepare(
            "INSERT INTO memories VALUES('foreign-memory',?,'Privado','2026-10-15','2026-10-15')"
          )
          .bind(foreignUser),
      ];
      yield* Effect.tryPromise(() => db.batch(statements));
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE erasure_requests SET state='Archiving' WHERE id=?").bind(reference).run()
      );
      const first = makeMemoryErasureStores(db)[0];
      if (first === undefined) throw new Error("Missing Memory disposition");
      expect(yield* first.archive(scope)).toBe(false);
      const resumed = makeMemoryErasureStores(db)[0];
      if (resumed === undefined) throw new Error("Missing Memory disposition");
      expect(yield* resumed.archive(scope)).toBe(true);
      expect(yield* resumed.archive(scope)).toBe(true);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(reference).run()
      );
      expect((yield* Effect.result(resumed.remove({ reference, userId: foreignUser })))._tag).toBe(
        "Failure"
      );
      expect(yield* resumed.remove(scope)).toBe(false);
      expect(yield* resumed.remove(scope)).toBe(true);
      expect(yield* resumed.remove(scope)).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) FROM memories WHERE user_id=?").bind(userId).first("count(*)")
        )
      ).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT text FROM memories WHERE user_id=?").bind(foreignUser).first("text")
        )
      ).toBe("Privado");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) FROM erasure_archives WHERE request_id=?")
            .bind(reference)
            .first("count(*)")
        )
      ).toBe(70);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) FROM erasure_permits").first("count(*)")
        )
      ).toBe(0);
    })
  ));

it("expires ordinary review drafts while a sealed User remains under erasure disposition", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const current = yield* Clock.currentTimeMillis;
      const statements = [
        ...[userId, foreignUser].map((id) =>
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
            )
            .bind(id)
        ),
        ...[userId, foreignUser].flatMap((id) =>
          [0, 1].flatMap((index) =>
            retainedReviewRows({
              db,
              userId: id,
              id: `${id}-${index}`,
              created: index === 0 ? current - 31 * 86400000 : 1,
              current,
              status: "pending",
              transactionId: Option.none(),
            })
          )
        ),
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,1,'Sealing')"
          )
          .bind(reference, userId),
      ];
      yield* Effect.tryPromise(() => db.batch(statements));
      yield* sweepReviewDrafts({ db, current });
      const retained = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT draft_json FROM ingestion_review_workspace_state WHERE user_id=? ORDER BY id"
          )
          .bind(userId)
          .all()
      );
      expect(retained.results).toEqual([
        { draft_json: '{"counterparty":"Personal draft"}' },
        { draft_json: '{"counterparty":"Personal draft"}' },
      ]);
      const expired = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT draft_json FROM ingestion_review_workspace_state WHERE user_id=? ORDER BY id"
          )
          .bind(foreignUser)
          .all()
      );
      expect(expired.results).toEqual([{ draft_json: null }]);
    })
  ));

it.each([
  {
    kind: "email",
    table: "verified_email_credentials",
    stores: makeEmailAuthenticationErasureStores,
    columns: "address,verified_at_ms",
    target: "'target@example.test',101",
    foreign: "'foreign@example.test',202",
    change: "address='changed@example.test'",
  },
  {
    kind: "recovery",
    table: "backup_recovery_credentials",
    stores: makeRecoveryErasureStores,
    columns: "code_digest,created_at_ms,revision",
    target: "zeroblob(32),101,3",
    foreign: "randomblob(32),202,7",
    change: "revision=revision+1",
  },
])(
  "erases only the selected User's $kind credential and retries a rolled-back deletion independently of Identity",
  ({ table, stores, columns, target, foreign, change }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* Effect.tryPromise(() => installRetentionTestSchema(db));
        yield* Effect.tryPromise(() =>
          db.batch([
            ...[userId, foreignUser].map((id) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(id)
            ),
            db
              .prepare(
                `INSERT INTO ${table}(user_id,${columns}) VALUES(?,${target}),(?,${foreign})`
              )
              .bind(userId, foreignUser),
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,1,'AwaitingReview',?)"
              )
              .bind(reference, userId, '{"dispositions":{"credentials":{"action":"Delete"}}}'),
            db
              .prepare(
                `INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES(?,'${table}','credentials')`
              )
              .bind(reference),
            db.prepare("UPDATE erasure_requests SET state='Archiving' WHERE id=?").bind(reference),
          ])
        );
        const before = yield* Effect.tryPromise(() =>
          db.prepare(`SELECT rowid,* FROM ${table} ORDER BY user_id`).all()
        );
        const store = stores(db).find((item) => item.id === table);
        if (store === undefined) throw Error("Missing credential erasure owner");
        expect(yield* store.archive(scope)).toBe(true);
        yield* Effect.tryPromise(() =>
          db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(reference).run()
        );
        yield* Effect.tryPromise(() =>
          expect(
            db.prepare(`UPDATE ${table} SET ${change} WHERE user_id=?`).bind(userId).run()
          ).rejects.toThrow("erasure_fenced")
        );
        expect((yield* Effect.result(store.remove({ reference, userId: foreignUser })))._tag).toBe(
          "Failure"
        );
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                `INSERT INTO erasure_chunk(request_id,row_ref) SELECT ?,CAST(rowid AS TEXT) FROM ${table} WHERE user_id=?`
              )
              .bind(reference, foreignUser),
            db.prepare(`CREATE TRIGGER interrupt_credential_delete AFTER DELETE ON ${table}
          BEGIN SELECT RAISE(ABORT,'interrupted credential deletion'); END`),
          ])
        );
        expect((yield* Effect.result(store.remove(scope)))._tag).toBe("Failure");
        expect(
          (yield* Effect.tryPromise(() =>
            db.prepare(`SELECT rowid,* FROM ${table} ORDER BY user_id`).all()
          )).results
        ).toEqual(before.results);
        yield* Effect.tryPromise(() =>
          db.prepare("DROP TRIGGER interrupt_credential_delete").run()
        );
        const resumed = stores(db).find((item) => item.id === table);
        if (resumed === undefined) throw Error("Missing resumed credential erasure owner");
        expect(yield* resumed.remove(scope)).toBe(true);
        expect(yield* resumed.remove(scope)).toBe(true);
        expect(
          (yield* Effect.tryPromise(() => db.prepare(`SELECT rowid,* FROM ${table}`).all())).results
        ).toEqual(before.results.filter((row) => row.user_id === foreignUser));
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM users ORDER BY id").all()))
            .results
        ).toEqual([{ id: userId }, { id: foreignUser }]);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM erasure_permits").all()))
            .results
        ).toEqual([]);
      })
    )
);
