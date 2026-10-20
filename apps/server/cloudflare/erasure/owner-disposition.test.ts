import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Schema } from "effect";
import { installRetentionTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
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
          [0, 1].map((index) =>
            db
              .prepare(`INSERT INTO ingestion_review_state
        (id,user_id,status,revision,draft_json,expires_at_ms,updated_at_ms,created_at_ms)
        VALUES(?,?,'pending',1,'{"counterparty":"Personal draft"}',?,?,?)`)
              .bind(`${id}-${index}`, id, current - 1, current, index === 0 ? current : 1)
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
          .prepare("SELECT draft_json FROM ingestion_review_state WHERE user_id=? ORDER BY id")
          .bind(userId)
          .all()
      );
      expect(retained.results).toEqual([
        { draft_json: '{"counterparty":"Personal draft"}' },
        { draft_json: '{"counterparty":"Personal draft"}' },
      ]);
      const expired = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT draft_json FROM ingestion_review_state WHERE user_id=? ORDER BY id")
          .bind(foreignUser)
          .all()
      );
      expect(expired.results).toEqual([{ draft_json: null }]);
    })
  ));
