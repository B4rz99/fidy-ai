import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  alice,
  bob,
  makeNativeTransactionJourney,
  nativeBrowserWrite,
} from "../financial-user-store.test-fixture";
import { native, nativePurgePlatform } from "../user-store.test-fixture";
import { canonicalRequestProtection } from "../canonical-admission/contract";
import { canonicalRetryLifetimeMs } from "../../src/core/quotas/contract";

const setup = Effect.fn(function* () {
  const db = yield* makeNativeTransactionJourney(undefined, nativePurgePlatform);
  const users = yield* native(() => db.runtime.getDurableObjectNamespace("USER_STORE", "core"));

  const alarm = Effect.fn(function* (at: number) {
    return yield* native(() =>
      users.getByName(alice.user).fetch("https://fixture.invalid/user-alarm", {
        method: "POST",
        headers: { "fixture-clock": String(at) },
      })
    );
  });

  const post = nativeBrowserWrite(db);

  const issue = Effect.fn(function* (requestId: string) {
    const current = yield* Clock.currentTimeMillis;

    const response = yield* post(alice, {
      path: "/pats",
      method: "POST",
      body: {
        requestId,
        grant: {
          recipientLabel: "CLI",
          scopes: ["dashboard", "read"],
          lifetimeDays: 7,
          reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(current + 604800000)),
        },
      },
    });

    expect(response.status).toBe(200);

    return (yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        data: Schema.Struct({
          bearer: Schema.String,
          pat: Schema.Struct({ shortId: Schema.String, expiresAt: Schema.String }),
        }),
      })
    )(yield* native(() => response.json()))).data;
  });

  return { db, post, alarm, issue };
});

const expiry = Effect.gen(function* () {
  const { db, alarm, issue } = yield* setup();
  const { bearer, pat } = yield* issue("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed");
  const at = DateTime.makeUnsafe(pat.expiresAt).epochMilliseconds + 1;
  yield* native(() =>
    db.exec(
      "CREATE TRIGGER hold_expiry BEFORE INSERT ON consent_history WHEN NEW.record_type='pat_revocation' BEGIN SELECT RAISE(IGNORE); END"
    )
  );
  expect((yield* alarm(at)).status).toBe(503);
  expect(
    yield* native(() => db.exec("SELECT revoked_at_ms FROM pats WHERE short_id=?", pat.shortId))
  ).toEqual([{ revoked_at_ms: null }]);
  yield* native(() => db.exec("DROP TRIGGER hold_expiry"));
  expect((yield* alarm(at)).status).toBe(204);
  expect((yield* alarm(at + 1)).status).toBe(204);

  const records = yield* native(() =>
    db.exec(
      "SELECT p.revoked_at_ms,c.reason,c.session_id FROM pats p JOIN consent_history c ON c.pat_id=p.id WHERE p.short_id=? AND c.record_type='pat_revocation'",
      pat.shortId
    )
  );

  expect(records).toEqual([
    { revoked_at_ms: at, reason: "pat-fixed-lifetime-expiry", session_id: null },
  ]);

  const denied = yield* native(() =>
    db.send(
      new Request("https://api.fidyapp.com/categories", {
        headers: { authorization: "Bearer " + bearer },
      })
    )
  );

  expect(denied.status).toBe(401);
});

const rolling = Effect.gen(function* () {
  const { db, post } = yield* setup();

  const review = Effect.fn(function* (who: typeof alice) {
    yield* Effect.sleep(canonicalRequestProtection.intervalMs);

    return yield* post(who, {
      method: "POST",
      path: "/pats/pairings/inspect",
      body: { publicCode: "invalid" },
    });
  });

  const statuses = yield* Effect.forEach(
    Array.from({ length: 10 }),
    () => review(alice).pipe(Effect.map((reply) => reply.status)),
    { concurrency: 1 }
  );

  expect(statuses).toEqual(Array(10).fill(400));
  expect((yield* review(alice)).status).toBe(429);
  expect((yield* review(bob)).status).toBe(400);
  yield* native(() =>
    db.exec(
      "UPDATE pat_review_events SET expires_at_ms=0 WHERE id IN(SELECT id FROM pat_review_events ORDER BY id LIMIT 5)"
    )
  );

  expect(
    yield* Effect.forEach(
      Array.from({ length: 5 }, () => alice),
      (person) => review(person).pipe(Effect.map((response) => response.status))
    )
  ).toEqual(Array.from({ length: 5 }, () => 400));
  expect((yield* review(alice)).status).toBe(429);
  expect(
    yield* native(() => db.owner(bob.user).exec("SELECT count(*) n FROM pat_review_events"))
  ).toEqual([{ n: 1 }]);
});

const cleanup = Effect.gen(function* () {
  const { db, alarm, issue } = yield* setup();
  const { pat, bearer } = yield* issue("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

  const current = yield* Clock.currentTimeMillis,
    future = current + canonicalRetryLifetimeMs + 86400000;

  const call = Effect.fn(function* (key: string) {
    return yield* native(() =>
      db.send(
        new Request("https://api.fidyapp.com/dashboard/initialize", {
          method: "POST",
          headers: {
            "Fidy-Retry-Key": key,
            authorization: "Bearer " + bearer,
            "content-type": "application/json",
          },
          body: "{}",
        })
      )
    );
  });

  expect((yield* call("old")).status).toBe(200);
  expect((yield* call("live")).status).toBe(200);
  yield* native(() =>
    db.exec(
      "UPDATE canonical_request_receipts SET accepted_at_ms=? WHERE rowid=(SELECT max(rowid) FROM canonical_request_receipts WHERE operation='dashboard.initializeDashboard')",
      future
    )
  );

  yield* Effect.forEach(
    [
      ["old", current],
      ["live", future + 3600000],
    ] as const,
    Effect.fnUntraced(function* ([label, deadline]) {
      yield* native(() =>
        db.exec("INSERT INTO canonical_request_leases VALUES(?,?,?)", label, alice.user, deadline)
      );
      yield* native(() =>
        db.exec("INSERT INTO canonical_request_buckets VALUES(?,?)", label, deadline)
      );
      yield* native(() =>
        db.exec(
          "INSERT INTO pat_review_events(session_id,expires_at_ms) VALUES(?,?)",
          alice.session,
          deadline
        )
      );
    }),
    { discard: true }
  );

  expect((yield* alarm(future)).status).toBe(204);
  expect(
    yield* native(() =>
      db.exec("SELECT id FROM canonical_request_leases WHERE id IN('old','live')")
    )
  ).toEqual([{ id: "live" }]);
  expect(
    yield* native(() =>
      db.exec("SELECT subject FROM canonical_request_buckets WHERE subject IN('old','live')")
    )
  ).toEqual([{ subject: "live" }]);
  expect(yield* native(() => db.exec("SELECT count(*) n FROM pat_review_events"))).toEqual([
    { n: 1 },
  ]);
  expect(
    yield* native(() =>
      db.exec(
        "SELECT accepted_at_ms FROM canonical_request_receipts WHERE operation='dashboard.initializeDashboard'"
      )
    )
  ).toEqual([{ accepted_at_ms: future }]);
  expect(
    yield* native(() => db.exec("SELECT count(*) n FROM pats WHERE short_id=?", pat.shortId))
  ).toEqual([{ n: 1 }]);
});

const anonymous = Effect.gen(function* () {
  const { db, post, alarm } = yield* setup();

  const start = Effect.fn(function* () {
    const request = new Request("https://api.fidyapp.com/pat-pairings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        recipientLabel: "CLI",
        scopes: ["read"],
        lifetimeDays: 7,
      }),
    });

    const response = yield* native(() => db.send(request));
    expect(response.status).toBe(200);

    return yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        pairingId: Schema.String,
        publicCode: Schema.String,
        expiresAt: Schema.String,
      })
    )(yield* native(() => response.json()));
  });

  const pending = yield* start(),
    approved = yield* start();

  expect(
    (yield* post(alice, {
      path: "/pats/pairings/inspect",
      method: "POST",
      body: { publicCode: approved.publicCode },
    })).status
  ).toBe(200);
  expect(
    (yield* post(alice, {
      path: "/pats/pairings/approve",
      method: "POST",
      body: { pairingId: approved.pairingId },
    })).status
  ).toBe(200);
  const at = DateTime.makeUnsafe(approved.expiresAt).epochMilliseconds + 1;

  const directory = (yield* native(() =>
    db.runtime.getDurableObjectNamespace("DIRECTORY", "core")
  )).getByName("directory-v1");

  yield* native(() =>
    directory.fetch("https://fixture.invalid/directory-alarm", {
      headers: { "fixture-erasure-clock": String(at) },
    })
  );
  expect(
    yield* native(() =>
      db.directory.exec("SELECT id FROM pat_bootstrap WHERE id=?", pending.pairingId)
    )
  ).toEqual([]);
  yield* native(() =>
    db.exec(
      "CREATE TRIGGER hold_pairing BEFORE UPDATE OF state ON pat_pairings WHEN NEW.state='revoked_unclaimed' BEGIN SELECT RAISE(IGNORE); END"
    )
  );
  expect((yield* alarm(at)).status).toBe(503);
  expect(
    yield* native(() => db.exec("SELECT state FROM pat_pairings WHERE id=?", approved.pairingId))
  ).toEqual([{ state: "approved_awaiting_claim" }]);
  yield* native(() => db.exec("DROP TRIGGER hold_pairing"));
  expect((yield* alarm(at)).status).toBe(204);
  expect((yield* alarm(at + 1)).status).toBe(204);
  expect(
    yield* native(() =>
      db.exec(
        "SELECT record_type FROM consent_history WHERE pairing_id=? ORDER BY record_type",
        approved.pairingId
      )
    )
  ).toEqual([{ record_type: "pat_grant" }, { record_type: "pat_revocation" }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "removes expired anonymous pairings while preserving the original approved grant and unclaimed revocation",
    () => anonymous
  );
  test.effect(
    "expires a fixed PAT and its policy Consent exactly once, and rolls back a refused evidence write",
    () => expiry
  );
  test.effect(
    "charges malformed reviews under each live session and refills only its expired attempts",
    () => rolling
  );
  test.effect(
    "the idle User alarm removes only stale receipts, leases, burst windows and review attempts",
    () => cleanup
  );
});
