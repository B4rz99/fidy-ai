import {
  preparePATReviewAdmission,
  prepareResourceCounter,
} from "../resource-admission/operations";
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
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal',?,?,?,?,?)"
        )
        .bind(withdrawal, userId, userId, userId, input.current + 1)
        .run()
    );
    yield* Effect.tryPromise(() =>
      expect(
        input.db
          .prepare(
            "INSERT INTO consent_history (record_type,id,user_id,withdrawal_id,grant_record_id,session_id,disclosure_json,accepted_at_ms) VALUES ('processing_renewal',?,?,?,?,?,'{}',?)"
          )
          .bind(withdrawal, userId, withdrawal, userId, userId, input.current + 2)
          .run()
      ).rejects.toThrow("erasure_fenced")
    );
  });

const verifyNewStoreGuards = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    for (const kind of ["email_pairing_user", "email_replacement"] as const) {
      yield* Effect.tryPromise(() =>
        expect(
          prepareResourceCounter({
            db,
            kind,
            current,
            workId: userId,
            subject: { sql: "SELECT ? AS user_id", params: [userId] },
          }).run()
        ).rejects.toThrow("erasure_fenced")
      );
    }
    yield* Effect.tryPromise(() =>
      expect(
        db.batch([
          ...preparePATReviewAdmission({
            db,
            id: "14330000-0000-4000-8000-000000000099",
            sessionId: userId,
            userId,
            current,
            eligible: { sql: "SELECT 1", params: [] },
          }),
        ])
      ).rejects.toThrow("erasure_fenced")
    );
    for (const recordType of ["processing_withdrawal", "processing_renewal"]) {
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(`DELETE FROM consent_history WHERE record_type='${recordType}' AND user_id=?`)
            .bind(foreignUser)
            .run()
        ).rejects.toThrow("consent_history_retention_required")
      );
    }
    yield* Effect.tryPromise(() =>
      expect(
        db
          .prepare("UPDATE user_documents SET user_id=? WHERE kind='recurring-plan' AND user_id=?")
          .bind(foreignUser, userId)
          .run()
      ).rejects.toThrow("erasure_fenced")
    );
  });

const seedReviewAdmission = (
  db: D1Database,
  current: number
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    for (const id of [userId, foreignUser]) {
      const prepared = preparePATReviewAdmission({
        db,
        id,
        sessionId: id,
        userId: id,
        current,
        eligible: { sql: "SELECT 1", params: [] },
      });
      const otherCharge =
        id === userId
          ? [
              db
                .prepare(
                  "INSERT INTO resource_admission_events(grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,window_start_epoch_ms,expires_at_epoch_ms) VALUES(?,'foreign-owned','stable_user',?,'rolling_window',1,?,?,?)"
                )
                .bind(id, foreignUser, current, current, current + 600000),
              db
                .prepare(
                  "INSERT INTO resource_admission_grants(id,admitted_at_epoch_ms,claim_count) VALUES(?,?,2)"
                )
                .bind(id, current),
            ]
          : prepared.slice(1);
      yield* Effect.tryPromise(() => db.batch([...prepared.slice(0, 1), ...otherCharge]));
    }
    yield* Effect.tryPromise(() =>
      expect(
        db.batch([
          ...preparePATReviewAdmission({
            db,
            id: reference,
            sessionId: foreignUser,
            userId,
            current,
            eligible: { sql: "SELECT 1", params: [] },
          }),
        ])
      ).rejects.toThrow("resource_admission_owner_mismatch")
    );
  });

const verifyRetainedReviews = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT owner_user_id FROM resource_admission_events WHERE policy_key='pat.review.session.v1'"
          )
          .all()
      )).results
    ).toEqual([{ owner_user_id: foreignUser }]);
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT count(*) AS total FROM resource_admission_grants WHERE id=?")
          .bind(userId)
          .first()
      ))?.total
    ).toBe(1);
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT scope_key FROM resource_admission_events WHERE grant_id=?")
          .bind(userId)
          .first()
      ))?.scope_key
    ).toBe(foreignUser);
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
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms) VALUES(?1,'CO','es-CO','America/Bogota',?2,?2,?2+604800000)"
          )
          .bind(id, current)
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
  yield* seedReviewAdmission(db, current);
  yield* Effect.tryPromise(() =>
    db.batch([
      ...[userId, foreignUser].flatMap((id) => {
        const subject = { sql: "SELECT ? AS user_id", params: [id] };
        return [
          prepareResourceCounter({ db, kind: "email_pairing_user", subject, current }),
          prepareResourceCounter({ db, kind: "email_replacement", subject, current, workId: id }),
        ];
      }),
      prepareResourceCounter({
        db,
        kind: "email_pairing_global",
        current,
        subject: { sql: "SELECT ? AS user_id", params: [userId] },
      }),
    ])
  );
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
  expect(
    (yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT owner_user_id,count(*) AS retained FROM resource_admission_counters GROUP BY owner_user_id ORDER BY owner_user_id"
        )
        .all()
    )).results
  ).toEqual([
    { owner_user_id: null, retained: 1 },
    { owner_user_id: foreignUser, retained: 2 },
  ]);
  yield* verifyRetainedReviews(db);
  for (const table of [
    "ingestion_review_state",
    "(SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL)",
    "transactions",
    "source_attestations",
    "pats",
    "consent_history",
    "hosted_agent_sessions",
    "transcript_entries",
    "recurring_series",
    "(SELECT user_id,document_json,revision FROM user_documents WHERE kind='dashboard')",
    "schedules",
    "web_sessions",
    "(SELECT * FROM audit_entries WHERE record_type='session_call')",
    "(SELECT user_id,document_json,revision FROM user_documents WHERE kind='recurring-plan')",
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
    ).toBe(
      new Map([
        ["transcript_entries", 2],
        ["consent_history", 3],
      ]).get(table) ?? 1
    );
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
