import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Schema } from "effect";
import {
  microsoftProviderPaths,
  providerPaths,
} from "../../src/shell/provider-authentication/contract";
import { disposeJourneys, setup } from "./journey.test-fixture";
import { sweepProviderAuthentication } from "./runtime";

afterAll(disposeJourneys);
const Count = Schema.Struct({ count: Schema.Int });
const count = (db: D1Database, table: string): Promise<number> =>
  db
    .prepare(`SELECT count(*) AS count FROM ${table}`)
    .first()
    .then(Schema.decodeUnknownSync(Count))
    .then((row) => row.count);

it("shares a durable source budget across every provider route and ignores forged source keys", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, pairing } = yield* Effect.tryPromise(() => setup());
      const responses = yield* Effect.tryPromise(() =>
        Promise.all(
          Array.from({ length: 125 }, (_, index) =>
            send(providerPaths.disclosure, undefined, {
              "x-provider-source": String(index).padStart(64, "0"),
            })
          )
        )
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(120);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(5);
      for (const paths of [providerPaths, microsoftProviderPaths]) {
        for (const path of [paths.start, paths.status, paths.complete]) {
          const response = yield* Effect.tryPromise(() =>
            send(path, { ...pairing, intent: "login", consentRevision: "" })
          );
          expect(response.status).toBe(429);
          expect(response.headers.get("retry-after")).toBe("60");
        }
        expect((yield* Effect.tryPromise(() => send(paths.callback))).status).toBe(429);
      }
      expect(yield* Effect.tryPromise(() => count(db, "provider_authentication_attempts"))).toBe(0);
      expect(yield* Effect.tryPromise(() => count(db, "users"))).toBe(0);
    })
  ));

it("caps expensive invalid requests separately before admitting another provider attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, pairing } = yield* Effect.tryPromise(() => setup());
      const responses = yield* Effect.tryPromise(() =>
        Promise.all(
          Array.from({ length: 32 }, (_, index) =>
            send(index % 2 === 0 ? providerPaths.start : microsoftProviderPaths.complete, {})
          )
        )
      );
      expect(responses.filter((response) => response.status === 400)).toHaveLength(30);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
      expect(
        (yield* Effect.tryPromise(() =>
          send(microsoftProviderPaths.start, { ...pairing, intent: "login", consentRevision: "" })
        )).status
      ).toBe(429);
      expect(yield* Effect.tryPromise(() => count(db, "provider_authentication_attempts"))).toBe(0);
      expect(yield* Effect.tryPromise(() => count(db, "users"))).toBe(0);
    })
  ));

it("bounds proof-bearing polling across changing sources without consuming or changing the pairing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, pairing } = yield* Effect.tryPromise(() => setup());
      expect(
        (yield* Effect.tryPromise(() =>
          send(providerPaths.start, { ...pairing, intent: "login", consentRevision: "" })
        )).status
      ).toBe(200);
      const responses = yield* Effect.tryPromise(() =>
        Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            send(providerPaths.status, pairing, { "cf-connecting-ip": `192.0.2.${index + 1}` })
          )
        )
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
      const state = yield* Effect.tryPromise(() =>
        db.prepare("SELECT state FROM provider_authentication_attempts").first()
      );
      expect(state).toEqual({ state: "pending" });
      expect(yield* Effect.tryPromise(() => count(db, "users"))).toBe(0);
      // Expire accounting at the platform seam without altering the proof's own lifetime.
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE resource_admission_events SET expires_at_epoch_ms=admitted_at_epoch_ms-1000, admitted_at_epoch_ms=admitted_at_epoch_ms-60000"
          )
          .run()
      );
      expect((yield* Effect.tryPromise(() => send(providerPaths.status, pairing))).status).toBe(
        200
      );
    })
  ));

it("atomically enforces global capacity across distinct sources and fails closed without admission storage", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, pairing } = yield* Effect.tryPromise(() => setup());
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              `INSERT INTO resource_admission_events VALUES ('fixture','provider.global.v1','operation','all','rolling_window',1199,?,?,?,NULL)`
            )
            .bind(now, now - 60000, now + 60000),
          db.prepare("INSERT INTO resource_admission_grants VALUES ('fixture',?,1)").bind(now),
        ])
      );
      const responses = yield* Effect.tryPromise(() =>
        Promise.all(
          [1, 2].map((source) =>
            send(providerPaths.start, {}, { "cf-connecting-ip": `192.0.2.${source}` })
          )
        )
      );
      expect(
        responses.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([400, 429]);
      expect(yield* Effect.tryPromise(() => count(db, "provider_authentication_attempts"))).toBe(0);
      yield* Effect.tryPromise(() => db.prepare("DROP TABLE resource_admission_events").run());
      expect(
        (yield* Effect.tryPromise(() =>
          send(providerPaths.start, { ...pairing, intent: "login", consentRevision: "" })
        )).status
      ).toBe(503);
      expect(yield* Effect.tryPromise(() => count(db, "provider_authentication_attempts"))).toBe(0);
    })
  ));

it("removes only expired provider admission evidence during owner maintenance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() => send(providerPaths.disclosure));
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              `INSERT INTO resource_admission_events VALUES ('foreign','foreign','operation','all','rolling_window',1,?,?,?,NULL)`
            )
            .bind(now - 120000, now - 180000, now - 60000),
          db
            .prepare("INSERT INTO resource_admission_grants VALUES ('foreign',?,1)")
            .bind(now - 120000),
        ])
      );
      yield* sweepProviderAuthentication({ db, current: now });
      expect(yield* Effect.tryPromise(() => count(db, "resource_admission_grants"))).toBe(2);
      yield* sweepProviderAuthentication({ db, current: now + 61000 });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT id FROM resource_admission_grants")
            .all()
            .then((result) => result.results)
        )
      ).toEqual([{ id: "foreign" }]);
    })
  ));

it("rejects missing trusted source evidence before Core admission or domain writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, pairing } = yield* Effect.tryPromise(() => setup());
      const response = yield* Effect.tryPromise(() =>
        send(
          providerPaths.start,
          { ...pairing, intent: "login", consentRevision: "" },
          new Headers({
            origin: "https://app.fidyapp.com",
            "content-type": "application/json",
            "x-provider-source": "a".repeat(64),
          })
        )
      );
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => count(db, "resource_admission_grants"))).toBe(0);
      expect(yield* Effect.tryPromise(() => count(db, "provider_authentication_attempts"))).toBe(0);
    })
  ));
