import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { expect } from "vitest";
import { alice, bob, makeNativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native, nativePurgePlatform } from "../user-store.test-fixture";

const setup = Effect.fn(function* () {
  const db = yield* makeNativeTransactionJourney(undefined, nativePurgePlatform);

  const users = yield* native(() => db.runtime.getDurableObjectNamespace("USER_STORE", "core")),
    bucket = yield* native(() => db.runtime.getR2Bucket("STATEMENT_STAGING_BUCKET", "core")),
    now = yield* Clock.currentTimeMillis;

  const alarm = Effect.fn(function* (at: number) {
    return yield* native(() =>
      users.getByName(alice.user).fetch("https://fixture.invalid/user-alarm", {
        method: "POST",
        headers: { "fixture-clock": String(at) },
      })
    );
  });

  const retain = Effect.fn(function* (
    who: typeof alice,
    state: "queued" | "processing",
    expires: number
  ) {
    const user = who.user,
      key = "users/" + user + "/staging/statement/v1/" + user,
      local = db.owner(user);

    yield* native(() => bucket.put(key, "original"));
    yield* native(() =>
      local.exec(
        "INSERT INTO statement_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0)",
        user,
        user,
        "portfolio",
        "CO.Source",
        "message",
        "endpoint",
        "media",
        now - 1000,
        now - 1000,
        expires,
        key,
        now
      )
    );
    yield* native(() =>
      local.exec(
        "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,published_submission_id,source_format) VALUES(?,?,?,8,?,'published',?,?,?,'csv')",
        user,
        user,
        key,
        "0".repeat(64),
        now - 1000,
        expires,
        user
      )
    );
    yield* native(() =>
      local.exec(
        "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,status,retention_expires_at_ms,started_at_ms) VALUES(?,?,?,?,?,?,?,?)",
        user,
        user,
        user,
        user,
        now - 1000,
        state,
        expires,
        state === "processing" ? now - 1000 : null
      )
    );
    yield* native(() => local.exec("INSERT INTO statement_backfill VALUES(?,?,NULL)", user, user));

    return key;
  });

  return { db, bucket, now, alarm, retain };
});

const retention = Effect.fn(function* (status: "queued" | "processing") {
  const { db, bucket, now, alarm, retain } = yield* setup(),
    expires = now + 10000;

  const key = yield* retain(alice, status, expires),
    foreign = yield* retain(bob, status, expires);

  yield* native(() =>
    db.exec("ALTER TABLE forwarded_email_receipts RENAME TO fixture_unavailable_email")
  );
  expect((yield* alarm(expires + 1)).status).toBe(503);
  expect(
    yield* native(() =>
      db.exec("SELECT status,failure_reason,completed_at_ms FROM statement_submissions")
    )
  ).toEqual([
    { status: "failed", failure_reason: "retention-expired", completed_at_ms: expires + 1 },
  ]);
  expect(yield* native(() => bucket.head(key))).toBeNull();
  expect(yield* native(() => bucket.head(foreign))).not.toBeNull();
  expect(yield* native(() => db.exec("SELECT count(*) n FROM statement_backfill"))).toEqual([
    { n: 0 },
  ]);
  expect(
    yield* native(() => db.owner(bob.user).exec("SELECT status FROM statement_submissions"))
  ).toEqual([{ status }]);
  yield* native(() =>
    db.exec("ALTER TABLE fixture_unavailable_email RENAME TO forwarded_email_receipts")
  );
  expect((yield* alarm(expires + 2)).status).toBe(204);
});

const dispatch = Effect.fn(function* (interrupted: boolean) {
  const { db, now, alarm, retain } = yield* setup(),
    expires = now + 86400000;

  yield* retain(alice, "queued", expires);
  yield* native(() =>
    db.exec("ALTER TABLE ingestion_review_items RENAME TO fixture_unavailable_review")
  );
  yield* native(() =>
    db.exec(
      "UPDATE statement_submissions SET work_published_at_ms=?,work_last_attempt_at_ms=?",
      now - 70000,
      interrupted ? now - 65000 : null
    )
  );
  expect((yield* alarm(now)).status).toBe(503);
  expect(
    yield* native(() => db.exec("SELECT work_last_attempt_at_ms FROM statement_submissions"))
  ).toEqual([{ work_last_attempt_at_ms: now }]);
  yield* native(() =>
    db.exec("ALTER TABLE fixture_unavailable_review RENAME TO ingestion_review_items")
  );
});

const expiredTurn = Effect.gen(function* () {
  const { db, now, alarm } = yield* setup(),
    old = now - 31 * 86400000;

  const add = Effect.fn(function* (who: typeof alice, suffix: string, time: number) {
    const local = db.owner(who.user),
      session = "session-" + suffix,
      turn = "turn-" + suffix;

    yield* native(() =>
      local.exec(
        "INSERT INTO hosted_agent_sessions(id,user_id,basis_json,start_ms,active_ms,compacted_text,compacted_through) VALUES(?,?,'{}',?,?,'private summary',1)",
        session,
        who.user,
        time,
        time
      )
    );
    yield* native(() =>
      local.exec(
        "INSERT INTO hosted_turns(id,user_id,session_id,start_ms,deadline_ms,request_text,state,answer,terminal_ms) VALUES(?,?,?,?,?,'private question','failed','private answer',?)",
        turn,
        who.user,
        session,
        time,
        time + 5000,
        time + 1
      )
    );
    yield* native(() =>
      local.exec(
        "INSERT INTO hosted_transcript(session_id,turn_id,entry_json) VALUES(?,?,?)",
        session,
        turn,
        '{"content":"private"}'
      )
    );
  });

  yield* add(alice, "old", old);
  yield* add(alice, "current", now - 86400000);
  yield* add(bob, "foreign", old);
  expect((yield* alarm(now)).status).toBe(204);

  const snapshot =
    "SELECT t.id,t.state,t.request_text,t.answer,s.compacted_text,(SELECT count(*) FROM hosted_transcript WHERE turn_id=t.id) AS entries FROM hosted_turns t JOIN hosted_agent_sessions s ON s.id=t.session_id ORDER BY t.id";

  const current = {
    state: "failed",
    request_text: "private question",
    answer: "private answer",
    compacted_text: "private summary",
    entries: 1,
  };

  expect(yield* native(() => db.exec(snapshot))).toEqual([
    { id: "turn-current", ...current },
    {
      id: "turn-old",
      state: "failed",
      request_text: "",
      answer: null,
      compacted_text: null,
      entries: 0,
    },
  ]);
  expect(yield* native(() => db.owner(bob.user).exec(snapshot))).toEqual([
    { id: "turn-foreign", ...current },
  ]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "erases expired personal Turn content while preserving terminal metadata, current content and the other User",
    () => expiredTurn
  );
  test.effect.each(["queued", "processing"] as const)(
    "the actual User alarm expires a %s submission and releases the unconsumed Free backfill and original object despite independent email failure",
    retention
  );
  test.effect.each([false, true])(
    "independent review failure still permits a fresh or abandoned statement Queue offer, previously attempted=%s",
    dispatch
  );
});
