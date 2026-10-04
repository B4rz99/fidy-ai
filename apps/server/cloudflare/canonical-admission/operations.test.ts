import { Clock, Data, DateTime, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { QuotaStatus } from "../../src/core/quotas/contract";
import { UserId } from "../../src/core/identity/contract";
import {
  type CatalogOperation,
  getBoundOperationCatalog,
} from "../../src/shell/canonical-catalog/contract";
import "../../src/shell/api";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { executeCanonicalQuery } from "../canonical-operations/operations";
import { protectCanonicalRequest, protectCanonicalSource } from "./operations";
import type { AuthorizedCanonicalCaller } from "./contract";

class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
const io = <A>(run: () => Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = UserId.make("10000000-0000-4000-8000-000000000001");
const patId = "20000000-0000-4000-8000-000000000001";
const digest = new Uint8Array(32).fill(1);
const caller: AuthorizedCanonicalCaller = {
  _tag: "PAT",
  value: { userId, patId, digest, requiredScope: Option.some("read") },
};
const targetId = "30000000-0000-4000-8000-000000000001";
const operation = (id: string): CatalogOperation =>
  Option.getOrThrow(Option.fromUndefinedOr(getBoundOperationCatalog().byId.get(id)));
const setup = Effect.gen(function* () {
  const db = yield* io(() => databases.acquire());
  const names = yield* io(() =>
    Array.fromAsync(
      new Bun.Glob("*.sql").scan({ cwd: new URL("../migrations/", import.meta.url).pathname })
    )
  );
  yield* io(() =>
    installTestSchema({
      db,
      sources: names.sort().map((name) => new URL(`../migrations/${name}`, import.meta.url)),
    })
  );
  const current = yield* Clock.currentTimeMillis;
  yield* io(() =>
    db.batch([
      db
        .prepare("INSERT INTO users VALUES (?,'CO','es-CO','America/Bogota',?)")
        .bind(userId, current),
      db
        .prepare(
          "INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES (?,?,'12345678',?,'agent','[\"read\"]',7,?,?,?,?)"
        )
        .bind(
          patId,
          userId,
          digest,
          current,
          current,
          current + 604800000,
          "40000000-0000-4000-8000-000000000001"
        ),
      db.prepare("CREATE TABLE domain_effects (id INTEGER PRIMARY KEY)"),
    ])
  );
  return { db, current };
});
type Fixture = Readonly<{ db: D1Database; current: number }>;

it("keeps recovery Audit saturation distinct from commercial exhaustion and store failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* io(() =>
        fixture.db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<256)
   INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
   SELECT printf('quota-budget-%d',n),?,?,'transactions.listTransactions','accepted',? FROM seq`)
          .bind(userId, patId, fixture.current)
          .run()
      );
      for (const id of ["quota.getQuota", "subscription.getUpgradeUrl"] as const) {
        const response = yield* inspect(fixture, id);
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("1");
      }
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ total: 0 });
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
        )
      ).toEqual({ last_used_at_ms: null });
    })
  ));

it("attributes malformed retry references without commercial consumption or successful PAT activity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      expect((yield* read(fixture, Option.some(""))).status).toBe(400);
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT operation,outcome FROM pat_audit WHERE user_id = ?")
            .bind(userId)
            .all()
        )
      ).toMatchObject({
        results: [{ operation: "transactions.getTransaction", outcome: "rejected" }],
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ total: 0 });
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
        )
      ).toEqual({ last_used_at_ms: null });
    })
  ));

it("shares quota inspection and upgrade recovery with catalog query execution", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      for (const id of ["quota.getQuota", "subscription.getUpgradeUrl"] as const) {
        const result = yield* executeCanonicalQuery({
          db: fixture.db,
          subject: caller.value,
          operation: operation(id).id,
          input: {},
          bucket: Option.none(),
        });
        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) expect(result.value.status).toBe(200);
      }
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("does not advance PAT activity from admission without the domain owner's Audit proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      expect((yield* read(fixture, Option.none())).status).toBe(404);
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
        )
      ).toEqual({ last_used_at_ms: null });
    })
  ));

it("attributes completed replay disclosure to the current PAT without reexecuting or charging", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const key = "audited-replay";
      yield* read(fixture, Option.some(key));
      const otherId = "20000000-0000-4000-8000-000000000002";
      const otherDigest = new Uint8Array(32).fill(2);
      yield* io(() =>
        fixture.db
          .prepare(
            "INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) SELECT ?,user_id,'87654321',?,'second','[\"read\"]',7,created_at_ms,issued_at_ms,expires_at_ms,? FROM pats WHERE id = ?"
          )
          .bind(otherId, otherDigest, "40000000-0000-4000-8000-000000000002", patId)
          .run()
      );
      const replay = yield* protectCanonicalRequest({
        ...fixture,
        caller: { _tag: "PAT", value: { ...caller.value, patId: otherId, digest: otherDigest } },
        operation: operation("transactions.getTransaction"),
        browserOrigin: "http://localhost:3000",
        request: new Request(`https://core.internal/transactions/${targetId}`, {
          headers: { "Fidy-Retry-Key": key },
        }),
        work: work(fixture.db),
      });
      expect(replay.status).toBe(404);
      expect(yield* effects(fixture.db)).toEqual({ total: 1 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT user_id,pat_id,operation,outcome FROM pat_audit WHERE pat_id = ?")
            .bind(otherId)
            .all()
        )
      ).toMatchObject({
        results: [
          {
            user_id: userId,
            pat_id: otherId,
            operation: "transactions.getTransaction",
            outcome: "rejected",
          },
        ],
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ total: 1 });
    })
  ));

const work = (db: D1Database): Effect.Effect<Response, TestFailure> =>
  io(() => db.prepare("INSERT INTO domain_effects DEFAULT VALUES").run()).pipe(
    Effect.as(
      Response.json(
        { error: { code: "not_found", message: "Transaction unavailable." }, next: [] },
        { status: 404 }
      )
    )
  );
const read = (
  fixture: Fixture,
  key: Option.Option<string>,
  { id, implementation } = { id: targetId, implementation: work(fixture.db) }
): Effect.Effect<Response> =>
  protectCanonicalRequest({
    ...fixture,
    caller,
    operation: operation("transactions.getTransaction"),
    browserOrigin: "http://localhost:3000",
    request: new Request(`https://core.internal/transactions/${id}`, {
      headers: Option.isSome(key) ? { "Fidy-Retry-Key": key.value } : {},
    }),
    work: implementation,
  });
const inspect = (
  fixture: Fixture,
  op: "quota.getQuota" | "subscription.getUpgradeUrl"
): Effect.Effect<Response> =>
  protectCanonicalRequest({
    ...fixture,
    caller,
    operation: operation(op),
    browserOrigin: "http://localhost:3000",
    request: new Request(
      `https://core.internal${op === "quota.getQuota" ? "/quota" : "/subscription/upgrade-url"}`
    ),
    work: executeCanonicalQuery({
      db: fixture.db,
      subject: caller.value,
      operation: operation(op).id,
      input: {},
      bucket: Option.none(),
    }).pipe(Effect.map((result) => Option.getOrThrow(result))),
  });
const effects = (db: D1Database): Effect.Effect<unknown, TestFailure> =>
  io(() => db.prepare("SELECT count(*) AS total FROM domain_effects").first());

const batchRequest = (fixture: Fixture, retryKey: string): Effect.Effect<Response> => {
  const envelope = operation("operations.executeAtomicBatch");
  return protectCanonicalRequest({
    ...fixture,
    caller: { _tag: "PAT", value: { userId, patId, digest, requiredScope: Option.none() } },
    operation: envelope,
    browserOrigin: "http://localhost:3000",
    request: new Request(`https://core.internal${envelope.route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "Fidy-Retry-Key": retryKey },
      body: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
        calls: [
          {
            callId: "30000000-0000-4000-8000-000000000011",
            operation: "categories.createKeywordRule",
            input: {
              payload: { keyword: "mercado", categoryId: "10000000-0000-4000-8000-000000000003" },
            },
          },
          {
            callId: "30000000-0000-4000-8000-000000000012",
            operation: "categories.createKeywordRule",
            input: {
              payload: { keyword: "farmacia", categoryId: "10000000-0000-4000-8000-000000000007" },
            },
          },
        ],
      }),
    }),
    work: work(fixture.db),
  });
};

it("requires batch child capabilities before charging and charges an authorized batch envelope only once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const denied = yield* batchRequest(fixture, "batch");
      expect(denied.status).toBe(403);
      expect(yield* effects(fixture.db)).toEqual({ total: 0 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT COUNT(*) AS total FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ total: 0 });
      yield* io(() =>
        fixture.db
          .prepare("UPDATE pats SET scopes_json = '[\"write\"]' WHERE id = ?")
          .bind(patId)
          .run()
      );
      const accepted = yield* batchRequest(fixture, "batch");
      expect(accepted.status).toBe(404);
      expect(accepted.headers.get("Fidy-Canonical-Remaining")).toBe("49");
      expect((yield* batchRequest(fixture, "batch")).headers.get("Fidy-Canonical-Remaining")).toBe(
        "49"
      );
      expect(yield* effects(fixture.db)).toEqual({ total: 1 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT user_id AS userId,pat_id AS patId,operation FROM canonical_request_acceptances"
            )
            .first()
        )
      ).toEqual({ userId, patId, operation: "operations.executeAtomicBatch" });
    })
  ));

it("does not disclose a retained batch when the current PAT lacks its child capabilities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* io(() =>
        fixture.db
          .prepare("UPDATE pats SET scopes_json = '[\"write\"]' WHERE id = ?")
          .bind(patId)
          .run()
      );
      yield* batchRequest(fixture, "batch");
      yield* io(() =>
        fixture.db
          .prepare("UPDATE pats SET scopes_json = '[\"read\"]' WHERE id = ?")
          .bind(patId)
          .run()
      );
      const replay = yield* batchRequest(fixture, "batch");
      expect(replay.status).toBe(403);
      expect(yield* io(() => replay.text())).not.toContain("domain refusal");
      expect(yield* effects(fixture.db)).toEqual({ total: 1 });
    })
  ));

it("counts an admitted domain refusal once and returns its exact retained result on replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const first = yield* read(fixture, Option.some("same"));
      const firstBody = yield* io(() => first.text());
      expect(first.status).toBe(404);
      expect(first.headers.get("Fidy-Canonical-Remaining")).toBe("49");
      const second = yield* read(fixture, Option.some("same"));
      expect(second.status).toBe(404);
      expect(yield* io(() => second.text())).toBe(firstBody);
      expect(second.headers.get("Fidy-Canonical-Remaining")).toBe("49");
      expect(yield* effects(fixture.db)).toEqual({ total: 1 });
      const mismatch = yield* read(fixture, Option.some("same"), {
        id: "30000000-0000-4000-8000-000000000002",
        implementation: work(fixture.db),
      });
      expect(mismatch.status).toBe(400);
      expect(yield* effects(fixture.db)).toEqual({ total: 1 });
    })
  ));

it("rechecks revoked authority before disclosing replay and never restarts its expiry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const { db, current } = fixture;
      yield* read(fixture, Option.some("same"));
      const before = yield* io(() =>
        db.prepare("SELECT expires_at_ms AS expiry FROM canonical_request_replays").first()
      );
      yield* read({ ...fixture, current: current + 1000 }, Option.some("same"));
      expect(
        yield* io(() =>
          db.prepare("SELECT expires_at_ms AS expiry FROM canonical_request_replays").first()
        )
      ).toEqual(before);
      yield* io(() =>
        db.prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?").bind(current, patId).run()
      );
      expect((yield* read(fixture, Option.some("same"))).status).toBe(401);
      expect(yield* effects(db)).toEqual({ total: 1 });
    })
  ));

it("admits a new metered request after the absolute retry window expires", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* read(fixture, Option.some("same"));
      yield* io(() =>
        fixture.db
          .prepare("UPDATE canonical_request_replays SET accepted_at_ms = ?,expires_at_ms = ?")
          .bind(fixture.current - 86400001, fixture.current - 1)
          .run()
      );
      const fresh = yield* read(fixture, Option.some("same"));
      expect(fresh.headers.get("Fidy-Canonical-Remaining")).toBe("48");
      expect(yield* effects(fixture.db)).toEqual({ total: 2 });
    })
  ));

it("keeps inspection and upgrade available at zero and refuses before domain execution", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const { db, current } = fixture;
      const statusResponse = yield* inspect(fixture, "quota.getQuota");
      const status = yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(Schema.Struct({ data: QuotaStatus }))
      )(yield* io<unknown>(() => statusResponse.json()));
      if (status.data.canonicalCalls._tag !== "Limited") {
        return yield* new TestFailure({ cause: "expected Free" });
      }
      const startsAt = DateTime.toEpochMillis(status.data.canonicalCalls.period.startsAt);
      yield* io(() =>
        db.batch(
          Array.from({ length: 50 }, (_, index) =>
            db
              .prepare(
                "INSERT INTO commercial_allowance_consumptions VALUES (?,'canonical_call',?,?,?,1)"
              )
              .bind(userId, `seed-${index}`, startsAt, current)
          )
        )
      );
      const refused = yield* read(fixture, Option.none());
      expect(refused.status).toBe(429);
      expect(refused.headers.get("Fidy-Canonical-Remaining")).toBe("0");
      expect(yield* io<unknown>(() => refused.json())).toMatchObject({
        error: {
          code: "quota_exhausted",
          allowance: "canonical_call",
          resetsAt: DateTime.formatIso(status.data.canonicalCalls.period.resetsAt),
        },
      });
      expect((yield* inspect(fixture, "quota.getQuota")).status).toBe(200);
      expect((yield* inspect(fixture, "subscription.getUpgradeUrl")).status).toBe(200);
      expect(yield* effects(db)).toEqual({ total: 0 });
    })
  ));

it("does not spend commercial quota on malformed input and enforces the ten-request burst even for recovery queries", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      expect(
        (yield* read(fixture, Option.none(), { id: "malformed", implementation: work(fixture.db) }))
          .status
      ).toBe(400);
      for (let index = 0; index < 9; index++) {
        expect((yield* inspect(fixture, "quota.getQuota")).status).toBe(200);
      }
      const refusal = yield* inspect(fixture, "quota.getQuota");
      expect(refusal.status).toBe(429);
      expect(refusal.headers.get("retry-after")).toBe("1");
      expect(yield* effects(fixture.db)).toEqual({ total: 0 });
    })
  ));

it("shares two request slots across a User and releases them after work completes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        const gate = yield* Deferred.make<void>();
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const held = (started: Deferred.Deferred<void>): Effect.Effect<Response, TestFailure> =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return yield* work(fixture.db);
          });
        const first = yield* Effect.forkScoped(
          read(fixture, Option.some("first"), { id: targetId, implementation: held(firstStarted) })
        );
        yield* Deferred.await(firstStarted);
        const second = yield* Effect.forkScoped(
          read(fixture, Option.some("second"), {
            id: targetId,
            implementation: held(secondStarted),
          })
        );
        yield* Deferred.await(secondStarted);
        expect((yield* read(fixture, Option.some("third"))).status).toBe(429);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(
          yield* io(() =>
            fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
          )
        ).toEqual({ total: 0 });
      })
    )
  ));

it("bounds unresolved credentials by a trusted keyed source without using commercial quota", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const request = new Request("https://core.internal/quota", {
        headers: { "x-canonical-source": "a".repeat(64) },
      });
      for (let index = 0; index < 10; index++) {
        expect(Option.isNone(yield* protectCanonicalSource({ ...fixture, request }))).toBe(true);
      }
      const refusal = Option.getOrThrow(yield* protectCanonicalSource({ ...fixture, request }));
      expect(refusal.status).toBe(429);
      expect(refusal.headers.get("retry-after")).toBe("1");
    })
  ));
