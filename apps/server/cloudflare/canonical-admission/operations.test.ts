import { browserSessionBindingHeader } from "~/shell/browser-transport/contract";
import {
  type CatalogOperation,
  getBoundOperationCatalog,
} from "../../src/shell/canonical-catalog/contract";
import { type AuthorizedCanonicalCaller } from "./contract";
import { Clock, Data, DateTime, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { type Mock, afterAll, expect, it, vi } from "vitest";
import { CanonicalAllowance, canonicalAllowanceHeaders } from "../../src/shell/quotas/contract";
import { QuotaStatus } from "../../src/core/quotas/contract";
import { Unavailable } from "../../src/shell/public-http/contract";
import { UserId } from "../../src/core/identity/contract";

import { installTestSchema, isolatedTestDatabases, isolatedTestStorage } from "../d1-test-fixture";
import { maintenancePerformanceDatabase } from "../maintenance-performance.test-fixture";
import { executeCanonicalQuery } from "../canonical-operations/operations";
import {
  protectCanonicalBrowserRequest,
  protectCanonicalPressure,
  protectCanonicalRequest,
  protectCanonicalSource,
} from "./operations";
import { sweepCanonicalAdmission } from "./runtime";
import "../../src/shell/api";

class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
const io = <A>(run: () => Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) });
const databases = isolatedTestDatabases();
const storage = isolatedTestStorage();
afterAll(() => databases.dispose());
afterAll(() => storage.dispose());
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

  yield* io(() => installTestSchema({ db }));
  const current = yield* Clock.currentTimeMillis;
  yield* io(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
        )
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
const observeBatches = (
  db: D1Database
): Readonly<{
  database: D1Database;
  calls: Mock<(statements: D1PreparedStatement[]) => void>;
}> => {
  const calls = vi.fn<(statements: D1PreparedStatement[]) => void>();
  const database: D1Database = {
    prepare: db.prepare.bind(db),
    batch: <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> => {
      calls(statements);
      return db.batch<Row>(statements);
    },
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
    withSession: db.withSession.bind(db),
  };
  return { database, calls };
};
const browserSetup = Effect.gen(function* () {
  const fixture = yield* setup;
  const { db, current } = fixture;
  const pairingId = "50000000-0000-4000-8000-000000000001";
  const sessionId = "60000000-0000-4000-8000-000000000001";
  const token = "c".repeat(43);
  const browserDigest = new Uint8Array(
    yield* io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))
  );
  yield* io(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'BCDF-GHJK',?,?,'consumed',?,?)"
        )
        .bind(pairingId, digest, userId, current, current + 600_000),
      db
        .prepare(
          "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
        )
        .bind(
          sessionId,
          pairingId,
          userId,
          browserDigest,
          current,
          current + 600_000,
          current + 3_600_000,
          current + 7_776_000_000
        ),
    ])
  );
  const browserCaller: AuthorizedCanonicalCaller = {
    _tag: "WebSession",
    value: { id: sessionId, userId, digest: browserDigest },
  };
  const request = new Request("https://core.internal/transactions", {
    headers: { cookie: `__Host-fidy_session=${token}`, [browserSessionBindingHeader]: sessionId },
  });
  return { ...fixture, caller: browserCaller, request };
});

it("resolves mounted browser proof and acquires pressure in one guarded native unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserSetup;
      const { bucket } = yield* io(() => storage.acquire());
      yield* io(() => bucket.put("recovery/generation", "initial"));
      const generationReads = vi.fn();
      const observedBucket = new Proxy(bucket, {
        get: (target, property): unknown =>
          property === "get"
            ? (key: string): ReturnType<R2Bucket["get"]> => {
                generationReads();
                return target.get(key);
              }
            : Reflect.get(target, property, target),
      });
      const db = maintenancePerformanceDatabase({ db: fixture.db, bucket: observedBucket });
      const work = vi.fn((subject: typeof fixture.caller.value) =>
        Effect.sync(() => {
          expect(subject).toEqual(fixture.caller.value);
          return Response.json({ data: [], next: [] });
        })
      );
      const response = yield* protectCanonicalBrowserRequest({
        ...fixture,
        db,
        operation: operation("transactions.listTransactions"),
        work,
      });
      expect(response.status).toBe(200);
      expect(work).toHaveBeenCalledTimes(1);
      expect(reportedAllowance(response).remaining).toBe(50);
      expect(generationReads).toHaveBeenCalledTimes(2);
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

const invalidBrowserHeaders = ({
  request,
  invalid,
}: Readonly<{ request: Request; invalid: string }>): Headers => {
  const headers = new Headers(request.headers);
  if (invalid === "missing binding") headers.delete(browserSessionBindingHeader);
  if (invalid === "missing cookie") headers.delete("cookie");
  if (invalid === "forged cookie") headers.set("cookie", `__Host-fidy_session=${"d".repeat(43)}`);
  if (invalid === "duplicate cookie") {
    headers.append("cookie", `; __Host-fidy_session=${"c".repeat(43)}`);
  }
  return headers;
};

for (const invalid of [
  "missing binding",
  "missing cookie",
  "forged cookie",
  "different session",
  "duplicate cookie",
  "revoked",
  "expired",
  "withdrawn Consent",
] as const) {
  it(`rejects ${invalid} before browser pressure or owner work`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* browserSetup;
        const { db, current } = fixture;
        const headers = invalidBrowserHeaders({ request: fixture.request, invalid });
        if (invalid === "different session") {
          const otherUserId = "10000000-0000-4000-8000-000000000002";
          const otherPairingId = "50000000-0000-4000-8000-000000000002";
          const otherSessionId = "60000000-0000-4000-8000-000000000002";
          const otherDigest = new Uint8Array(32).fill(2);
          yield* io(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
                )
                .bind(otherUserId, current),
              db
                .prepare(
                  "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'LMNP-QRST',?,?,'consumed',?,?)"
                )
                .bind(otherPairingId, otherDigest, otherUserId, current, current + 600000),
              db
                .prepare(
                  "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
                )
                .bind(
                  otherSessionId,
                  otherPairingId,
                  otherUserId,
                  otherDigest,
                  current,
                  current + 600000,
                  current + 3600000,
                  current + 7776000000
                ),
            ])
          );
          headers.set(browserSessionBindingHeader, "60000000-0000-4000-8000-000000000002");
        }
        if (invalid === "revoked") {
          yield* io(() =>
            db.prepare("UPDATE web_sessions SET revoked_at_ms = ?").bind(current).run()
          );
        }
        if (invalid === "expired") {
          yield* io(() =>
            db.prepare("UPDATE web_sessions SET idle_expires_at_ms = ?").bind(current).run()
          );
        }
        if (invalid === "withdrawn Consent") {
          yield* io(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,'{}','disclosure','decision',?,?)"
                )
                .bind("grant", userId, current, current),
              db
                .prepare(
                  "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal',?,?,?,?,?)"
                )
                .bind("withdrawal", userId, "grant", fixture.caller.value.id, current),
            ])
          );
        }
        const work = vi.fn(() => Effect.succeed(Response.json({ private: "must not escape" })));
        const response = yield* protectCanonicalBrowserRequest({
          ...fixture,
          request: new Request(fixture.request, { headers }),
          operation: operation("transactions.listTransactions"),
          work,
        });
        expect(response.status).toBe(401);
        expect(work).not.toHaveBeenCalled();
        expect(response.headers.get(canonicalAllowanceHeaders.remaining)).toBeNull();
        for (const table of ["canonical_request_leases", "canonical_request_buckets"] as const) {
          expect(
            yield* io(() => db.prepare(`SELECT count(*) AS total FROM ${table}`).first())
          ).toEqual({ total: 0 });
        }
      })
    ));
}

it("enforces the shared browser burst and rolls back a refused lease", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserSetup;
      const work = vi.fn(() => Effect.succeed(Response.json({ data: [], next: [] })));
      const call = (): Effect.Effect<Response> =>
        protectCanonicalBrowserRequest({
          ...fixture,
          operation: operation("transactions.listTransactions"),
          work,
        });
      for (let index = 0; index < 10; index++) expect((yield* call()).status).toBe(200);
      const response = yield* call();
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(reportedAllowance(response).remaining).toBe(50);
      expect(work).toHaveBeenCalledTimes(10);
      const external = yield* protectCanonicalRequest({
        ...fixture,
        caller,
        request: new Request("https://core.internal/transactions"),
        operation: operation("transactions.listTransactions"),
        work: Effect.succeed(Response.json({ private: "must not escape" })),
      });
      expect(external.status).toBe(429);
      expect(reportedAllowance(external).remaining).toBe(50);
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("finishes browser disclosure and lease release in one guarded batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserSetup;
      const { bucket } = yield* io(() => storage.acquire());
      yield* io(() => bucket.put("recovery/generation", "initial"));
      const generationReads = vi.fn();
      const observedBucket = new Proxy(bucket, {
        get: (target, property): unknown =>
          property === "get"
            ? (key: string): ReturnType<R2Bucket["get"]> => {
                generationReads();
                return target.get(key);
              }
            : Reflect.get(target, property, target),
      });
      const guarded = maintenancePerformanceDatabase({ db: fixture.db, bucket: observedBucket });
      const { database, calls } = observeBatches(guarded);
      const response = yield* protectCanonicalRequest({
        ...fixture,
        db: database,
        operation: operation("transactions.listTransactions"),
        request: new Request("https://core.internal/transactions"),
        work: Effect.succeed(Response.json({ data: [], next: [] })),
      });
      expect(response.status).toBe(200);
      expect(reportedAllowance(response).remaining).toBe(50);
      expect(generationReads).toHaveBeenCalledTimes(2);
      expect(calls).toHaveBeenCalledTimes(2);
      expect(calls.mock.calls[1]?.[0]).toHaveLength(3);
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("withholds the body after browser revocation and releases the rolled-back lease", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserSetup;
      const response = yield* protectCanonicalRequest({
        ...fixture,
        operation: operation("transactions.listTransactions"),
        request: new Request("https://core.internal/transactions"),
        work: io(() =>
          fixture.db
            .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
            .bind(fixture.current, fixture.caller.value.id)
            .run()
        ).pipe(Effect.as(Response.json({ private: "must not escape" }))),
      });
      expect(response.status).toBe(401);
      expect(yield* io(() => response.text())).not.toContain("must not escape");
      expect(response.headers.get(canonicalAllowanceHeaders.remaining)).toBeNull();
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("fails closed and releases the lease when final disclosure is unavailable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserSetup;
      const { database, calls } = observeBatches(fixture.db);
      calls
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error("final disclosure unavailable");
        });
      const response = yield* protectCanonicalRequest({
        ...fixture,
        db: database,
        operation: operation("transactions.listTransactions"),
        request: new Request("https://core.internal/transactions"),
        work: Effect.succeed(Response.json({ private: "must not escape" })),
      });
      expect(response.status).toBe(503);
      expect(yield* io(() => response.text())).not.toContain("must not escape");
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("releases an admitted browser lease when work is interrupted", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* browserSetup;
        const started = yield* Deferred.make<void>();
        const running = yield* Effect.forkScoped(
          protectCanonicalRequest({
            ...fixture,
            operation: operation("transactions.listTransactions"),
            request: new Request("https://core.internal/transactions"),
            work: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          })
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(running);
        expect(
          yield* io(() =>
            fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
          )
        ).toEqual({ total: 0 });
      })
    )
  ));

const reportedAllowance = (response: Response): CanonicalAllowance =>
  Schema.decodeSync(Schema.toCodecJson(CanonicalAllowance))({
    allowance: response.headers.get(canonicalAllowanceHeaders.allowance),
    limit: response.headers.get(canonicalAllowanceHeaders.limit),
    remaining: response.headers.get(canonicalAllowanceHeaders.remaining),
    resetsAt: response.headers.get(canonicalAllowanceHeaders.resetsAt),
  });

const cliPresentation = Effect.fn(function* (
  response: Response,
  command: "quota" | "transaction" | "categories"
) {
  const body = yield* io(() => response.clone().text());
  const headers: Record<string, string> = {};
  for (const name of [...Object.values(canonicalAllowanceHeaders), "content-type", "retry-after"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const wire = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
    body,
    status: response.status,
    headers,
    command,
  });
  const deadlineMilliseconds = 15_000;
  const child = Bun.spawnSync(
    [process.execPath, new URL("../../../cli/test/allowance-entry.ts", import.meta.url).pathname],
    {
      stdin: new TextEncoder().encode(wire),
      timeout: deadlineMilliseconds,
    }
  );
  return {
    exitCode: child.exitCode,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
});

it("displays post-admission Free standing on a successful metered canonical call", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const response = yield* protectCanonicalRequest({
        ...fixture,
        caller,
        operation: operation("categories.listCategories"),
        request: new Request("https://core.internal/categories"),
        work: Effect.succeed(Response.json({ data: [], next: [] })),
      });
      expect(response.status).toBe(200);
      const output = yield* cliPresentation(response, "categories");
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toBe('{"data":[],"next":[]}\n');
      expect(output.stderr).toContain("49 de 50 llamadas canónicas restantes");
      expect(output.stderr).toContain(
        `${DateTime.formatIso(reportedAllowance(response).resetsAt)} (UTC)`
      );
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ total: 1 });
    })
  ));

it("publishes the reusable uncapped response contract during Trial without hiding security rejection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const trialDuration = 604_800_000;
      yield* io(() =>
        fixture.db
          .prepare("UPDATE users SET trial_started_at_ms=?2,trial_ends_at_ms=?3 WHERE id=?1")
          .bind(userId, fixture.current - 1, fixture.current - 1 + trialDuration)
          .run()
      );
      const success = yield* inspect(fixture, "quota.getQuota");
      expect(reportedAllowance(success)).toMatchObject({
        limit: "uncapped",
        remaining: "uncapped",
      });
      const successOutput = yield* cliPresentation(success, "quota");
      expect(successOutput.exitCode).toBe(0);
      expect(successOutput.stderr).toContain("sin medidor comercial mensual");
      expect(successOutput.stderr).not.toContain("llamadas canónicas restantes");
      expect(reportedAllowance(yield* read(fixture, Option.none()))).toMatchObject({
        limit: "uncapped",
        remaining: "uncapped",
      });
      for (let index = 0; index < 8; index++) yield* inspect(fixture, "quota.getQuota");
      const rejected = yield* inspect(fixture, "quota.getQuota");
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBe("1");
      expect(reportedAllowance(rejected)).toMatchObject({
        limit: "uncapped",
        remaining: "uncapped",
      });
      const rejectedOutput = yield* cliPresentation(rejected, "quota");
      expect(rejectedOutput.exitCode).toBe(1);
      expect(rejectedOutput.stdout).toContain('"code":"rate_limited"');
      expect(rejectedOutput.stderr).toContain("1 segundos");
      expect(rejectedOutput.stderr).toContain("sin medidor comercial mensual");
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
            .prepare(
              "SELECT operation,outcome FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE user_id = ?"
            )
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

it("returns the declared unavailable payload from both recovery owners on store failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const broken = new Proxy(fixture.db, {
        get(target, key): unknown {
          if (key === "batch") return () => Promise.reject(new Error("private-store-failure"));
          return Reflect.get(target, key, target);
        },
      });
      for (const id of ["quota.getQuota", "subscription.getUpgradeUrl"] as const) {
        const result = yield* executeCanonicalQuery({
          db: broken,
          subject: caller.value,
          operation: operation(id).id,
          input: {},
          bucket: Option.none(),
        });
        const response = Option.getOrThrow(result);
        expect(response.status).toBe(503);
        expect(
          yield* Schema.decodeUnknownEffect(Schema.toCodecJson(Unavailable))(
            yield* io(() => response.json())
          )
        ).toMatchObject({ error: { code: "unavailable" }, next: [] });
      }
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
        request: new Request(`https://core.internal/transactions/${targetId}`, {
          headers: { "Fidy-Retry-Key": key },
        }),
        work: work(fixture.db),
      });
      expect(replay.status).toBe(404);
      expect(reportedAllowance(replay)).toMatchObject({ limit: 50, remaining: 49 });
      const replayOutput = yield* cliPresentation(replay, "transaction");
      expect(replayOutput.exitCode).toBe(1);
      expect(replayOutput.stderr).toContain("49 de 50 llamadas canónicas restantes");
      expect(replayOutput.stdout).toContain('"code":"not_found"');
      expect(yield* effects(fixture.db)).toEqual({ total: 1 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT user_id,pat_id,operation,outcome FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE pat_id = ?"
            )
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
              "SELECT user_id AS userId,pat_id AS patId,operation,occurred_at_ms AS occurredAt FROM (SELECT id,user_id,pat_id,operation,occurred_at_ms FROM audit_entries WHERE record_type='request_admission') AS canonical_request_acceptances"
            )
            .first()
        )
      ).toEqual({
        userId,
        patId,
        operation: "operations.executeAtomicBatch",
        occurredAt: fixture.current,
      });
      yield* io(() =>
        fixture.db
          .prepare(
            "INSERT INTO audit_entries(record_type,id,user_id,operation,outcome,occurred_at_ms) VALUES('publication','retained-publication',?,'ingestion.submitForExtraction','success',?)"
          )
          .bind(userId, fixture.current)
          .run()
      );
      const admissionLifetime = 93 * 86400000;
      yield* sweepCanonicalAdmission({
        db: fixture.db,
        current: fixture.current + admissionLifetime - 1,
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS n FROM audit_entries WHERE record_type='request_admission'"
            )
            .first()
        )
      ).toEqual({ n: 1 });
      yield* sweepCanonicalAdmission({
        db: fixture.db,
        current: fixture.current + admissionLifetime,
      });
      expect(
        yield* io(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS n FROM audit_entries WHERE record_type='request_admission'"
            )
            .first()
        )
      ).toEqual({ n: 0 });
      expect(
        yield* io(() =>
          fixture.db
            .prepare("SELECT id,occurred_at_ms FROM audit_entries WHERE record_type='publication'")
            .first()
        )
      ).toEqual({ id: "retained-publication", occurred_at_ms: fixture.current });
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
      const before = yield* read(fixture, Option.some("same"));
      const body = yield* io(() => before.text());
      const retry = yield* read({ ...fixture, current: current + 1000 }, Option.some("same"));
      expect(yield* io(() => retry.text())).toBe(body);
      expect(retry.status).toBe(before.status);
      expect(retry.headers.get("content-type")).toBe(before.headers.get("content-type"));
      yield* io(() =>
        db.prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?").bind(current, patId).run()
      );
      expect((yield* read(fixture, Option.some("same"))).status).toBe(401);
      expect(yield* effects(db)).toEqual({ total: 1 });
    })
  ));

it("replays until the exact original deadline and permits key reuse at that deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup;
      const first = yield* read(fixture, Option.some("same"));
      const originalBody = yield* io(() => first.text());
      const retry = yield* read(
        { ...fixture, current: fixture.current + 86_399_999 },
        Option.some("same")
      );
      expect(retry.status).toBe(first.status);
      expect(retry.headers.get("content-type")).toBe(first.headers.get("content-type"));
      expect(yield* io(() => retry.text())).toBe(originalBody);
      expect(yield* effects(fixture.db)).toEqual({ total: 1 });
      const fresh = yield* read(
        { ...fixture, current: fixture.current + 86_400_000 },
        Option.some("same")
      );
      expect(fresh.status).toBe(first.status);
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
      )(yield* io<unknown>(() => statusResponse.clone().json()));
      if (status.data.canonicalCalls._tag !== "Limited") {
        return yield* new TestFailure({ cause: "expected Free" });
      }
      const published = reportedAllowance(statusResponse);
      expect(published).toMatchObject({ limit: 50, remaining: 50 });
      const successOutput = yield* cliPresentation(statusResponse, "quota");
      expect(successOutput.exitCode).toBe(0);
      expect(successOutput.stderr).toContain("50 de 50 llamadas canónicas restantes");
      expect(successOutput.stdout).toBe((yield* io(() => statusResponse.clone().text())) + "\n");
      expect(DateTime.formatIso(published.resetsAt)).toBe(
        DateTime.formatIso(status.data.canonicalCalls.period.resetsAt)
      );
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
      expect(reportedAllowance(refused)).toMatchObject({ limit: 50, remaining: 0 });
      const refusedOutput = yield* cliPresentation(refused, "transaction");
      expect(refusedOutput.exitCode).toBe(1);
      expect(refusedOutput.stderr).toContain("0 de 50 llamadas canónicas restantes");
      expect(refusedOutput.stderr).toContain("sigue siendo Free");
      expect(refusedOutput.stderr).not.toContain("segundos");
      expect(refusedOutput.stdout).toBe((yield* io(() => refused.clone().text())) + "\n");
      expect(DateTime.formatIso(reportedAllowance(refused).resetsAt)).toBe(
        DateTime.formatIso(status.data.canonicalCalls.period.resetsAt)
      );
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

it("isolates recovery pressure between Users without clearing the exhausted User's burst", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, current } = yield* setup;
      const otherUser = UserId.make("10000000-0000-4000-8000-000000000002");
      yield* io(() =>
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(otherUser, current)
          .run()
      );
      const live = yield* Clock.Clock;
      const clock: Clock.Clock = {
        currentTimeMillis: Effect.succeed(current),
        currentTimeMillisUnsafe: () => current,
        currentTimeNanos: live.currentTimeNanos,
        currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
        monotonicTimeNanos: live.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
        sleep: (duration) => live.sleep(duration),
      };
      const recover = (subject: string): Effect.Effect<Response> =>
        protectCanonicalPressure({
          db,
          userId: subject,
          work: Effect.sync(() => new Response(null, { status: 200 })),
          refused: Effect.succeed,
        }).pipe(Effect.provideService(Clock.Clock, clock));
      for (let index = 0; index < 10; index++) {
        expect((yield* recover(userId)).status).toBe(200);
      }
      const refusal = yield* recover(userId);
      expect(refusal.status).toBe(429);
      expect(refusal.headers.get("retry-after")).toBe("1");
      expect((yield* recover(otherUser)).status).toBe(200);
      expect((yield* recover(userId)).status).toBe(429);
      expect(
        yield* io(() =>
          db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
      expect(
        yield* io(() =>
          db.prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 0 });
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

it("expires replay bodies at the original deadline in indexed bounded batches", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, current } = yield* setup;
      yield* io(() =>
        db.batch([
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1025)
            INSERT INTO canonical_request_replays(user_id,retry_key_digest,input_digest,operation,identity,accepted_at_ms,state,status,body,content_type)
            SELECT ?, 'expired-'||i, 'input', 'transactions.getTransaction', 'expired-'||i, ?, 'completed', 200, 'private response', 'application/json' FROM n`)
            .bind(userId, current - 86_400_000),
          db
            .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3000)
            INSERT INTO canonical_request_replays(user_id,retry_key_digest,input_digest,operation,identity,accepted_at_ms,state)
            SELECT ?, 'live-'||i, 'input', 'transactions.getTransaction', 'live-'||i, ?, 'pending' FROM n`)
            .bind(userId, current - 86_399_999),
        ])
      );
      let rowsRead = 0;
      const observed: D1Database = {
        prepare: db.prepare.bind(db),
        exec: db.exec.bind(db),
        dump: db.dump.bind(db),
        withSession: db.withSession.bind(db),
        batch: <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
          db.batch<Row>(statements).then((results) => {
            rowsRead = results.reduce((sum, result) => sum + result.meta.rows_read, 0);
            return results;
          }),
      };
      const count = (): Promise<number> =>
        db
          .prepare("SELECT count(*) AS total FROM canonical_request_replays")
          .first<number>("total")
          .then((value) => Option.getOrThrow(Option.fromNullOr(value)));
      yield* sweepCanonicalAdmission({ db: observed, current: current - 1 });
      expect(yield* io(count)).toBe(4025);
      expect(rowsRead).toBeLessThanOrEqual(10);
      yield* sweepCanonicalAdmission({ db: observed, current });
      expect(yield* io(count)).toBe(3001);
      expect(rowsRead).toBeLessThanOrEqual(6000);
      yield* sweepCanonicalAdmission({ db: observed, current });
      expect(yield* io(count)).toBe(3000);
      expect(rowsRead).toBeLessThanOrEqual(16);
      yield* sweepCanonicalAdmission({ db, current: current + 1 });
      expect(yield* io(count)).toBe(1976);
    })
  ));

it("retains browser concurrency limits without consuming a refused slot or burst token", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserSetup;
      yield* io(() =>
        fixture.db.batch([
          fixture.db
            .prepare("INSERT INTO canonical_request_leases VALUES ('held-1',?,?)")
            .bind(userId, fixture.current + 90000),
          fixture.db
            .prepare("INSERT INTO canonical_request_leases VALUES ('held-2',?,?)")
            .bind(userId, fixture.current + 90000),
        ])
      );
      const work = vi.fn(() => Effect.succeed(Response.json({ private: "must not escape" })));
      const response = yield* protectCanonicalBrowserRequest({
        ...fixture,
        operation: operation("transactions.listTransactions"),
        work,
      });
      expect(response.status).toBe(429);
      expect(reportedAllowance(response).remaining).toBe(50);
      expect(work).not.toHaveBeenCalled();
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 2 });
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_buckets").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("rechecks a bound browser credential before disclosing completed work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserSetup;
      const response = yield* protectCanonicalBrowserRequest({
        ...fixture,
        operation: operation("transactions.listTransactions"),
        work: () =>
          io(() =>
            fixture.db
              .prepare("UPDATE web_sessions SET revoked_at_ms = ?")
              .bind(fixture.current)
              .run()
          ).pipe(Effect.as(Response.json({ private: "must not escape" }))),
      });
      expect(response.status).toBe(401);
      expect(yield* io(() => response.text())).not.toContain("must not escape");
      expect(response.headers.get(canonicalAllowanceHeaders.remaining)).toBeNull();
      expect(
        yield* io(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

for (const transport of ["browser", "external"] as const) {
  it(`cleans a committed ${transport} slot when interruption arrives during native admission`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* browserSetup;
          const committed = yield* Deferred.make<void>();
          const settle = yield* Deferred.make<void>();
          const runWithServices = Effect.runPromiseWith(yield* Effect.context<never>());
          let first = true;
          const db: D1Database = {
            prepare: fixture.db.prepare.bind(fixture.db),
            batch: <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
              fixture.db.batch<Row>(statements).then((rows) => {
                if (!first) return rows;
                first = false;
                return runWithServices(
                  Deferred.succeed(committed, undefined).pipe(
                    Effect.andThen(Deferred.await(settle)),
                    Effect.as(rows)
                  )
                );
              }),
            exec: fixture.db.exec.bind(fixture.db),
            dump: fixture.db.dump.bind(fixture.db),
            withSession: fixture.db.withSession.bind(fixture.db),
          };
          const work = vi.fn(() => Effect.succeed(Response.json({ private: "must not escape" })));
          const call =
            transport === "browser"
              ? protectCanonicalBrowserRequest({
                  ...fixture,
                  db,
                  operation: operation("transactions.listTransactions"),
                  work,
                })
              : protectCanonicalRequest({
                  ...fixture,
                  db,
                  caller,
                  operation: operation("transactions.listTransactions"),
                  work: Effect.suspend(work),
                });
          const running = yield* Effect.forkChild(call);
          yield* Deferred.await(committed);
          const stopping = yield* Effect.forkChild(Fiber.interrupt(running));
          yield* Effect.yieldNow;
          yield* Deferred.succeed(settle, undefined);
          yield* Fiber.join(stopping);
          expect(work).not.toHaveBeenCalled();
          expect(
            yield* io(() =>
              fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
            )
          ).toEqual({ total: 0 });
        })
      )
    ));
}

for (const transport of ["browser", "external"] as const) {
  it(`cleans an uncertain ${transport} reservation after a lost native acknowledgement`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* browserSetup;
        let first = true;
        const db: D1Database = {
          prepare: fixture.db.prepare.bind(fixture.db),
          batch: <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
            fixture.db.batch<Row>(statements).then((rows) => {
              if (first) {
                first = false;
                throw new Error("Native commit acknowledgement lost");
              }
              return rows;
            }),
          exec: fixture.db.exec.bind(fixture.db),
          dump: fixture.db.dump.bind(fixture.db),
          withSession: fixture.db.withSession.bind(fixture.db),
        };
        const work = vi.fn(() => Effect.succeed(Response.json({ private: "must not escape" })));
        const input = { ...fixture, db, operation: operation("transactions.listTransactions") };
        const response = yield* transport === "browser"
          ? protectCanonicalBrowserRequest({ ...input, work })
          : protectCanonicalRequest({ ...input, caller, work: Effect.suspend(work) });
        expect(response.status).toBe(503);
        expect(work).not.toHaveBeenCalled();
        expect(
          yield* io(() =>
            fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
          )
        ).toEqual({ total: 0 });
      })
    ));
}
