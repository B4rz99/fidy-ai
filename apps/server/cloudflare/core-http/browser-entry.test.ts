import { browserSessionBindingHeader } from "../../src/shell/web-session/contract";
import { afterAll, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import {
  auditEntriesTestSchema,
  consentHistoryTestSchema,
  installCurrentTestObjects,
  isolatedTestDatabases,
} from "../d1-test-fixture";
import { initialBrowserSessionBindingResponse as browserSessionBindingResponse } from "./internal/browser-entry";

const holdInitialMetadata = Effect.fn(function* (db: D1Database) {
  const entered = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  let metadataPrepared = false;
  let held = false;
  const wrapped = new Proxy(db, {
    get(target, key): unknown {
      if (key === "prepare") {
        return (sql: string) => {
          if (sql.startsWith("SELECT * FROM (SELECT u.id")) metadataPrepared = true;
          return target.prepare(sql);
        };
      }
      if (key === "batch") {
        return async (statements: Array<D1PreparedStatement>) => {
          const result = await target.batch(statements);
          if (metadataPrepared && !held) {
            held = true;
            await Effect.runPromise(Deferred.succeed(entered, undefined));
            await Effect.runPromise(Deferred.await(released));
          }
          return result;
        };
      }
      return Reflect.get(target, key, target);
    },
  });
  return {
    db: wrapped,
    entered,
    release: Deferred.succeed(released, undefined),
  };
});

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000001";
const token = "d".repeat(43);
const current = 1_000_000;
const duration = 604800000;
const request = (): Request =>
  new Request("https://api.fidyapp.com/web/session/binding?context=application", {
    headers: { cookie: `__Host-fidy_session=${token}`, origin: "https://app.fidyapp.com" },
  });
const setup = (granted: boolean): Effect.Effect<D1Database, unknown> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    const digest = new Uint8Array(
      yield* Effect.tryPromise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
      )
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare(
          "CREATE TABLE users (id TEXT PRIMARY KEY, service_market TEXT, locale TEXT, time_zone TEXT, created_at_ms INTEGER, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER)"
        ),
        db.prepare(
          "CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT, token_digest BLOB, revoked_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)"
        ),
        db.prepare(consentHistoryTestSchema),
        db.prepare(auditEntriesTestSchema),
        db
          .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?, ?, ?)")
          .bind(userId, current, current, current + duration),
        db
          .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?, ?)")
          .bind(
            sessionId,
            userId,
            digest,
            current + duration,
            current + duration,
            current + duration
          ),
      ])
    );
    yield* Effect.tryPromise(() =>
      installCurrentTestObjects({
        db,
        tables: ["categories", "canonical_request_buckets", "canonical_request_leases"],
      })
    );
    if (granted) {
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO consent_history(record_type,user_id) VALUES('processing_grant',?)")
          .bind(userId)
          .run()
      );
    }
    yield* TestClock.setTime(current);
    return db;
  });

it.effect(
  "returns a fresh same-session Consent and User snapshot in the initial binding observation",
  () =>
    Effect.gen(function* () {
      const db = yield* setup(true);
      const response = Option.getOrThrow(
        yield* browserSessionBindingResponse({
          request: request(),
          db,
          browserOrigin: "https://app.fidyapp.com",
        })
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
        binding: sessionId,
        initial: {
          status: "Granted",
          withdrawal: null,
          profile: { data: { id: userId, timeZone: "America/Bogota" }, next: [] },
        },
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM audit_entries WHERE record_type='identity_read'"
            )
            .first()
        )
      ).toEqual({ count: 1 });
    })
);

it.effect("returns missing Consent without reading ordinary User metadata", () =>
  Effect.gen(function* () {
    const db = yield* setup(false);
    const response = Option.getOrThrow(
      yield* browserSessionBindingResponse({
        request: request(),
        db,
        browserOrigin: "https://app.fidyapp.com",
      })
    );
    expect(yield* Effect.tryPromise(() => response.json())).toEqual({
      binding: sessionId,
      initial: { status: "Missing", withdrawal: null },
    });
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM audit_entries WHERE record_type='identity_read'")
          .first()
      )
    ).toEqual({ count: 0 });
  })
);

it.effect("initial context retains the shared burst limit and releases its concurrency lease", () =>
  Effect.gen(function* () {
    const db = yield* setup(false);
    const statuses = [];
    for (let index = 0; index < 11; index++) {
      const response = Option.getOrThrow(
        yield* browserSessionBindingResponse({
          request: request(),
          db,
          browserOrigin: "https://app.fidyapp.com",
        })
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 200), 429]);
    expect(
      yield* Effect.tryPromise(() =>
        db.prepare("SELECT COUNT(*) AS count FROM canonical_request_leases").first()
      )
    ).toEqual({ count: 0 });
  })
);
it.effect("a foreign origin cannot request initial User metadata", () =>
  Effect.gen(function* () {
    const db = yield* setup(true);
    const response = Option.getOrThrow(
      yield* browserSessionBindingResponse({
        request: new Request(request(), {
          headers: { cookie: `__Host-fidy_session=${token}`, origin: "https://other.example" },
        }),
        db,
        browserOrigin: "https://app.fidyapp.com",
      })
    );
    expect(response.status).toBe(403);
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM audit_entries WHERE record_type='identity_read'")
          .first()
      )
    ).toEqual({ count: 0 });
  })
);
it.effect(
  "late Consent withdrawal drops the User metadata before initial context is released",
  () =>
    Effect.gen(function* () {
      const db = yield* setup(true);
      const held = yield* holdInitialMetadata(db);
      const running = yield* Effect.forkChild(
        browserSessionBindingResponse({
          request: request(),
          db: held.db,
          browserOrigin: "https://app.fidyapp.com",
        })
      );
      yield* Deferred.await(held.entered);
      const reference = "30000000-0000-4000-8000-000000000001";
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO consent_history(record_type,id,user_id,occurred_at_ms) VALUES('processing_withdrawal',?,?,?)"
          )
          .bind(reference, userId, current)
          .run()
      );
      yield* held.release;
      const response = Option.getOrThrow(yield* Fiber.join(running));
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        binding: sessionId,
        initial: { status: "Revoked", withdrawal: { reference, occurredAtMs: current } },
      });
    })
);
it.effect("late credential revocation releases no initial User metadata", () =>
  Effect.gen(function* () {
    const db = yield* setup(true);
    const held = yield* holdInitialMetadata(db);
    const running = yield* Effect.forkChild(
      browserSessionBindingResponse({
        request: request(),
        db: held.db,
        browserOrigin: "https://app.fidyapp.com",
      })
    );
    yield* Deferred.await(held.entered);
    yield* Effect.tryPromise(() =>
      db
        .prepare("UPDATE web_sessions SET revoked_at_ms=? WHERE id=?")
        .bind(current, sessionId)
        .run()
    );
    yield* held.release;
    const response = Option.getOrThrow(yield* Fiber.join(running));
    expect(yield* Effect.tryPromise(() => response.json())).toEqual({ binding: null });
  })
);

it.effect("rejects a mounted binding that does not match the current cookie", () =>
  Effect.gen(function* () {
    const db = yield* setup(true);
    const mismatched = request();
    mismatched.headers.set(browserSessionBindingHeader, "another-session");
    const response = Option.getOrThrow(
      yield* browserSessionBindingResponse({
        request: mismatched,
        db,
        browserOrigin: "https://app.fidyapp.com",
      })
    );
    expect(response.status).toBe(403);
    expect(
      yield* Effect.tryPromise(() =>
        db.prepare("SELECT COUNT(*) AS count FROM audit_entries").first()
      )
    ).toEqual({ count: 0 });
  })
);
