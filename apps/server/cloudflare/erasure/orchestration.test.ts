import { it as effectIt } from "@effect/vitest";
import { deletionDecision } from "./erasure.test-fixture";
import { expect } from "vitest";
import { type Cause, Clock, Effect, Schema } from "effect";
import { installRetentionTestSchema } from "../d1-test-fixture";
import { nativeErasurePlatform, seedPersonalClasses } from "./native.test-fixture";
import { NodeFileSystem } from "@effect/platform-node";

const userId = "12740000-0000-4000-8000-000000000001";
const foreignUser = "12740000-0000-4000-8000-000000000099";
const reference = "12740000-0000-4000-8000-000000000002";
const json = Schema.fromJsonString(Schema.Unknown);

const verifyRenewalFence = (
  input: Readonly<{ db: D1Database; current: number }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const withdrawal = "12740000-0000-4000-8000-000000000081";
    yield* Effect.tryPromise(() =>
      input.db
        .prepare("INSERT INTO consent_user_revocations VALUES(?,?,?,?,?)")
        .bind(withdrawal, userId, userId, userId, input.current + 1)
        .run()
    );
    yield* Effect.tryPromise(() =>
      expect(
        input.db
          .prepare("INSERT INTO processing_consent_renewals VALUES(?,?,?,?,?,'{}',?)")
          .bind(withdrawal, userId, withdrawal, userId, userId, input.current + 2)
          .run()
      ).rejects.toThrow("erasure_fenced")
    );
  });

const verifyNewStoreGuards = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    for (const table of ["processing_consent_withdrawal_records", "processing_consent_renewals"]) {
      yield* Effect.tryPromise(() =>
        expect(
          db.prepare(`DELETE FROM ${table} WHERE user_id=?`).bind(foreignUser).run()
        ).rejects.toThrow("consent_append_only")
      );
    }
    yield* Effect.tryPromise(() =>
      expect(
        db
          .prepare("UPDATE recurring_plan_documents SET user_id=? WHERE user_id=?")
          .bind(foreignUser, userId)
          .run()
      ).rejects.toThrow("erasure_fenced")
    );
  });

const verifyNativeErasure = Effect.gen(function* () {
  const platform = yield* nativeErasurePlatform;
  let native = yield* Effect.tryPromise(() => platform.acquire());
  let db = native.db;
  yield* Effect.tryPromise(() => installRetentionTestSchema(db));
  const current = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise(() =>
    db.batch([
      ...[userId, foreignUser].map((id) =>
        db.prepare("INSERT INTO users VALUES(?,'CO','es-CO','America/Bogota',?)").bind(id, current)
      ),
      db
        .prepare(
          "INSERT INTO memories VALUES('target-memory',?,'Borrar','2026-10-15','2026-10-15')"
        )
        .bind(userId),
      db
        .prepare(
          "INSERT INTO memories VALUES('foreign-memory',?,'Conservar','2026-10-15','2026-10-15')"
        )
        .bind(foreignUser),
      db
        .prepare(
          "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,?,'AwaitingReview')"
        )
        .bind(reference, userId, current),
    ])
  );
  for (const [index, id] of [userId, foreignUser].entries()) {
    yield* seedPersonalClasses({ db, userId: id, current, index });
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO ingestion_review_state
        (id,user_id,status,revision,draft_json,transaction_id,expires_at_ms,updated_at_ms,created_at_ms)
        VALUES(?,?,'created',1,'{"counterparty":"Personal draft"}',?,?,?,?)`)
        .bind(id, id, id, current + 86400000, current, current)
        .run()
    );
    const key = `staging/statement/v1/${(index === 0 ? "a" : "b").repeat(64)}`;
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms) VALUES(?,?,?,8,?,'available',?,?)"
        )
        .bind(id, id, key, "a".repeat(64), current, current + 86400000)
        .run()
    );
    yield* Effect.tryPromise(() =>
      native.originals.put(key, "Personal", {
        customMetadata: { purpose: "statement-original" },
      })
    );
  }
  const send = (path: string, body: unknown): Effect.Effect<Response, Schema.SchemaError> =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(json)(body);
      return yield* Effect.tryPromise(() =>
        native.coordinator.getByName(userId).fetch(
          new Request(`https://coordinator.internal/${path}`, {
            method: "POST",
            body: encoded,
          })
        )
      ).pipe(Effect.orDie);
    });
  const decision = deletionDecision({ userId, reference, current });
  expect(
    (yield* send("erasure-review", {
      userId,
      decision,
      authority: {
        permission: "titular.erase",
        operatorRef: "operator",
        expiresAtMs: current + 300000,
      },
      deadlineMs: current + 5000,
    })).status
  ).toBe(202);
  yield* verifyRenewalFence({ db, current });
  expect(
    (yield* send("erasure-continue", {
      userId,
      reference,
      authority: {
        permission: "titular.erase",
        operatorRef: "operator",
        expiresAtMs: current + 300000,
      },
      deadlineMs: (yield* Clock.currentTimeMillis) + 5000,
    })).status
  ).toBe(202);
  expect(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT state FROM erasure_requests WHERE id=?").bind(reference).first("state")
    )
  ).toBe("Sealing");
  yield* verifyNewStoreGuards(db);
  yield* Effect.tryPromise(() =>
    expect(
      db
        .prepare("UPDATE ingestion_review_state SET user_id=? WHERE user_id=?")
        .bind(foreignUser, userId)
        .run()
    ).rejects.toThrow("erasure_fenced")
  );
  expect(
    (yield* Effect.result(
      Effect.tryPromise(() =>
        db.prepare("UPDATE memories SET user_id=? WHERE user_id=?").bind(foreignUser, userId).run()
      )
    ))._tag
  ).toBe("Failure");
  expect(
    (yield* Effect.result(
      Effect.tryPromise(() =>
        db.prepare("DELETE FROM source_attestations WHERE user_id=?").bind(foreignUser).run()
      )
    ))._tag
  ).toBe("Failure");
  expect(
    (yield* Effect.result(
      Effect.tryPromise(() =>
        db.prepare("DELETE FROM source_attestations WHERE user_id=?").bind(userId).run()
      )
    ))._tag
  ).toBe("Failure");
  for (let count = 0; count < 450; count++) {
    if (count === 100) {
      native = yield* Effect.tryPromise(() => platform.restart());
      db = native.db;
    }
    const response = yield* send("erasure-continue", {
      userId,
      reference,
      authority: {
        permission: "titular.erase",
        operatorRef: "operator",
        expiresAtMs: current + 300000,
      },
      deadlineMs: (yield* Clock.currentTimeMillis) + 5000,
    });
    expect(response.status, `continuation ${count}`).toBe(202);
    const state = yield* Effect.tryPromise(() =>
      db.prepare("SELECT state FROM erasure_requests WHERE id=?").bind(reference).first("state")
    );
    if (state === "ExternalPending") break;
  }
  expect(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT state FROM erasure_requests WHERE id=?").bind(reference).first("state")
    )
  ).toBe("ExternalPending");
  expect(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT count(*) FROM users WHERE id=?").bind(userId).first("count(*)")
    )
  ).toBe(0);
  expect(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT text FROM memories WHERE user_id=?").bind(foreignUser).first("text")
    )
  ).toBe("Conservar");
  for (const table of [
    "ingestion_review_state",
    "whatsapp_identities",
    "transactions",
    "source_attestations",
    "pats",
    "onboarding_consent_records",
    "hosted_agent_sessions",
    "transcript_entries",
    "recurring_series",
    "dashboard_documents",
    "weekly_schedules",
    "subscription_identities",
    "web_sessions",
    "memory_audit",
    "recurring_plan_documents",
    "processing_consent_withdrawal_records",
    "processing_consent_renewals",
  ]) {
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id=?`)
          .bind(userId)
          .first<number>("count")
      ),
      table
    ).toBe(0);
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id=?`)
          .bind(foreignUser)
          .first<number>("count")
      ),
      table
    ).toBe(table === "transcript_entries" ? 2 : 1);
  }
  expect(
    yield* Effect.tryPromise(() => native.originals.head(`staging/statement/v1/${"a".repeat(64)}`))
  ).toBeNull();
  expect(
    yield* Effect.tryPromise(() =>
      native.originals
        .get(`staging/statement/v1/${"b".repeat(64)}`)
        .then((object) => object?.text())
    )
  ).toBe("Personal");
  expect(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT count(*) FROM erasure_permits").first("count(*)")
    )
  ).toBe(0);
});

effectIt.layer(NodeFileSystem.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "resumes every populated personal-data class under the native User coordinator and preserves the other User",
    () => verifyNativeErasure,
    { timeout: 60000 }
  );
});
