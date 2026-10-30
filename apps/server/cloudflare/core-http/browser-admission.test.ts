import { browserSessionBindingHeader } from "~/shell/browser-transport/contract";
import { type Cause, Clock, Effect, Option } from "effect";
import { type Mock, afterAll, expect, it, vi } from "vitest";
import { getBoundOperationCatalog } from "../../src/shell/canonical-catalog/contract";

import { webAuthenticationEndpoints } from "../../src/shell/web-authentication/contract";
import { oauthPaths } from "../../src/shell/oauth-agents/contract";
import { canonicalAllowanceHeaders } from "../../src/shell/quotas/contract";
import { installTestSchema, isolatedTestDatabases, isolatedTestStorage } from "../d1-test-fixture";
import { maintenancePerformanceDatabase } from "../maintenance-performance.test-fixture";
import { registeredConnectionInstitutionIds } from "../../src/shell/connections/contract";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry/operations";
import { type CoreHttpEnvironment, type CoreHttpHandler } from "./contract";
import { makeCoreHttp } from "./runtime";

const databases = isolatedTestDatabases();
const storage = isolatedTestStorage();
afterAll(() => databases.dispose());
afterAll(() => storage.dispose());

type BrowserReadFixture = Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  current: number;
  token: string;
  sessionId: string;
  userId: string;
  generationReads: Mock;
  core: CoreHttpHandler;
  environment: CoreHttpEnvironment;
  request: (headers?: Readonly<Record<string, string>>) => Promise<Response>;
}>;

const browserFixture = (): Effect.Effect<BrowserReadFixture, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() => installTestSchema({ db }));
    const current = yield* Clock.currentTimeMillis;
    const token = "b".repeat(43);
    const digest = new Uint8Array(
      yield* Effect.tryPromise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
      )
    );
    const userId = "10000000-0000-4000-8000-000000000001";
    const pairingId = "20000000-0000-4000-8000-000000000001";
    const sessionId = "30000000-0000-4000-8000-000000000001";
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(userId, current),
        db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'BCDF-GHJK',?,?,'consumed',?,?)"
          )
          .bind(pairingId, digest, userId, current, current + 600000),
        db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
          )
          .bind(
            sessionId,
            pairingId,
            userId,
            digest,
            current,
            current + 600000,
            current + 3600000,
            current + 7776000000
          ),
      ])
    );
    const { bucket } = yield* Effect.tryPromise(() => storage.acquire());
    yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
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
    const environment: CoreHttpEnvironment = {
      DB: maintenancePerformanceDatabase({ db, bucket: observedBucket }),
      RELEASE_GIT_SHA: "0".repeat(40),
      CONTRACT_DIGEST: "0".repeat(64),
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      USER_TRANSACTION_COORDINATOR: {
        getByName: () => ({
          fetch: () => Promise.reject(new Error("No coordinator work authorized")),
        }),
      },
      KAPSO_API_KEY: "unused",
      KAPSO_WEBHOOK_SECRET: "unused",
      WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
      WHATSAPP_BUSINESS_PORTFOLIO_ID: "unused",
      CLOUDFLARE_ACCESS_ISSUER: "https://unused.example",
      CLOUDFLARE_ACCESS_AUDIENCE: "unused",
      WOMPI_ENVIRONMENT: "sandbox",
      WOMPI_PUBLIC_KEY: "",
      WOMPI_PRIVATE_KEY: "",
      WOMPI_INTEGRITY_SECRET: "",
    };
    const core = makeCoreHttp({
      telemetry: cloudflareWorkerTelemetry,
      institutions: registeredConnectionInstitutionIds,
    });
    const categoryRoute = Option.getOrThrow(
      Option.fromUndefinedOr(getBoundOperationCatalog().byId.get("categories.listCategories"))
    ).route;
    const request = (headers: Readonly<Record<string, string>> = {}): Promise<Response> =>
      core(
        new Request(`https://api.fidyapp.com${categoryRoute}`, {
          headers: {
            cookie: `__Host-fidy_session=${token}`,
            [browserSessionBindingHeader]: sessionId,
            ...headers,
          },
        }),
        environment
      );
    return {
      db,
      bucket,
      current,
      token,
      sessionId,
      userId,
      generationReads,
      core,
      environment,
      request,
    };
  });

it.each([
  ["quota.getQuota", 3],
  ["categories.listCategories", 1],
] as const)("serves %s within %i fresh recovery-generation checks", (operationId, checks) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, token, sessionId, generationReads, core, environment } = yield* browserFixture();
      const operation = Option.getOrThrow(
        Option.fromUndefinedOr(getBoundOperationCatalog().byId.get(operationId))
      );
      const response = yield* Effect.tryPromise(() =>
        core(
          new Request(`https://api.fidyapp.com${operation.route}`, {
            headers: {
              cookie: `__Host-fidy_session=${token}`,
              [browserSessionBindingHeader]: sessionId,
            },
          }),
          environment
        )
      );
      expect(response.status).toBe(200);
      expect(generationReads).toHaveBeenCalledTimes(checks);
      const listing = Option.getOrThrow(
        Option.fromUndefinedOr(getBoundOperationCatalog().byId.get("pats.listPATs"))
      );
      for (const route of [
        { method: "GET", path: oauthPaths.authorize },
        { method: "POST", path: "/providers/kapso/callback" },
        { method: "POST", path: "/web/subscription/payment-enrollments/prepare" },
        { method: "POST", path: "/web/hosted-turns" },
        { method: "GET", path: webAuthenticationEndpoints.currentUser.path },
        { method: "GET", path: "/health" },
        { method: "POST", path: "/internal/titular-erasure" },
        { method: "GET", path: listing.route },
        { method: "GET", path: operation.route },
        { method: "GET", path: operation.route, authorization: "Bearer invalid" },
      ]) {
        generationReads.mockClear();
        const headers = new Headers({
          cookie: `__Host-fidy_session=${token}`,
          [browserSessionBindingHeader]: "30000000-0000-4000-8000-000000000002",
        });
        if (typeof route.authorization === "string") {
          headers.set("authorization", route.authorization);
        }
        const denied = yield* Effect.tryPromise(() =>
          core(
            new Request(`https://api.fidyapp.com${route.path}`, { method: route.method, headers }),
            environment
          )
        );
        expect(denied.status, `${route.method} ${route.path}`).toBe(401);
        expect(generationReads).toHaveBeenCalledTimes(1);
      }
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM canonical_request_buckets").first()
        )
      ).toEqual({ total: 1 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
    })
  )
);

const refusedBrowserHeaders: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "invalid Authorization": { authorization: "Bearer invalid" },
  "missing binding": { [browserSessionBindingHeader]: "" },
  "mismatched binding": { [browserSessionBindingHeader]: "30000000-0000-4000-8000-000000000002" },
  "missing cookie": { cookie: "" },
};

it.each([
  "revoked",
  "expired",
  "withdrawn Consent",
  "invalid Authorization",
  "missing binding",
  "mismatched binding",
  "missing cookie",
] as const)(
  "refuses the atomic Category read for %s without Audit, quota or a retained lease",
  (refusal) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* browserFixture();
        const { db, userId, sessionId, current } = fixture;
        if (refusal === "revoked") {
          yield* Effect.tryPromise(() =>
            db.prepare("UPDATE web_sessions SET revoked_at_ms = ?").bind(current).run()
          );
        }
        if (refusal === "expired") {
          yield* Effect.tryPromise(() =>
            db.prepare("UPDATE web_sessions SET idle_expires_at_ms = ?").bind(current).run()
          );
        }
        if (refusal === "withdrawn Consent") {
          yield* Effect.tryPromise(() =>
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
                .bind("withdrawal", userId, "grant", sessionId, current),
            ])
          );
        }
        const headers = Option.getOrElse(
          Option.fromUndefinedOr(refusedBrowserHeaders[refusal]),
          () => ({})
        );
        const response = yield* Effect.tryPromise(() => fixture.request(headers));
        expect(response.status).toBe(401);
        for (const table of [
          "audit_entries",
          "canonical_request_buckets",
          "canonical_request_leases",
          "commercial_allowance_consumptions",
        ]) {
          expect(
            yield* Effect.tryPromise(() =>
              db.prepare(`SELECT count(*) AS total FROM ${table}`).first()
            )
          ).toEqual({ total: 0 });
        }
      })
    )
);

it("keeps atomic Category standing bound to its caller when another User has an active TrialPeriod", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* Effect.tryPromise(() =>
        fixture.db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?,?,?)"
          )
          .bind(
            "10000000-0000-4000-8000-000000000002",
            fixture.current,
            fixture.current,
            fixture.current + 604800000
          )
          .run()
      );
      const response = yield* Effect.tryPromise(() => fixture.request());
      expect(response.status).toBe(200);
      const limit = response.headers.get(canonicalAllowanceHeaders.limit);
      expect(limit).toMatch(/^[1-9][0-9]*$/u);
      expect(response.headers.get(canonicalAllowanceHeaders.remaining)).toBe(limit);
    })
  ));

it.each(["caller", "another User"] as const)(
  "preserves outstanding leases for %s during an atomic Category read",
  (owner) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* browserFixture();
        const leaseUserId =
          owner === "caller" ? fixture.userId : "10000000-0000-4000-8000-000000000002";
        if (owner === "another User") {
          yield* Effect.tryPromise(() =>
            fixture.db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
              )
              .bind(leaseUserId, fixture.current)
              .run()
          );
        }
        const count = owner === "caller" ? 1 : 2;
        yield* Effect.tryPromise(() =>
          fixture.db.batch(
            Array.from({ length: count }, (_, index) =>
              fixture.db
                .prepare(
                  "INSERT INTO canonical_request_leases(id,user_id,expires_at_ms) VALUES (?,?,?)"
                )
                .bind(`held-${index}`, leaseUserId, fixture.current + 60000)
            )
          )
        );
        const response = yield* Effect.tryPromise(() => fixture.request());
        expect(response.status).toBe(200);
        expect(
          yield* Effect.tryPromise(() =>
            fixture.db
              .prepare("SELECT count(*) AS total FROM canonical_request_leases WHERE user_id = ?")
              .bind(leaseUserId)
              .first()
          )
        ).toEqual({ total: count });
      })
    )
);

it.each(["rate", "concurrency"] as const)("preserves atomic Category %s protection", (limit) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      const { db, userId, current } = fixture;
      if (limit === "rate") {
        yield* Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO canonical_request_buckets VALUES (?,?)")
            .bind(`user:${userId}`, current + 60000)
            .run()
        );
      } else {
        yield* Effect.tryPromise(() =>
          db.batch(
            ["occupied-1", "occupied-2"].map((id) =>
              db
                .prepare("INSERT INTO canonical_request_leases VALUES (?,?,?)")
                .bind(id, userId, current + 60000)
            )
          )
        );
      }
      const response = yield* Effect.tryPromise(() => fixture.request());
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: limit === "concurrency" ? 2 : 0 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM audit_entries").first()
        )
      ).toEqual({ total: 0 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 0 });
    })
  )
);

it("rolls back Category pressure and disclosure when required Audit is ignored", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      const { db } = fixture;
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER ignore_category_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='categories.listCategories' BEGIN SELECT RAISE(IGNORE); END"
          )
          .run()
      );
      const response = yield* Effect.tryPromise(() => fixture.request());
      expect(response.status).toBe(503);
      for (const table of [
        "audit_entries",
        "canonical_request_buckets",
        "canonical_request_leases",
        "commercial_allowance_consumptions",
      ]) {
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare(`SELECT count(*) AS total FROM ${table}`).first()
          )
        ).toEqual({ total: 0 });
      }
    })
  ));

it("closes malformed Category projections without leaving a lease or spending commercial quota", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      const { db } = fixture;
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO categories VALUES ('invalid-category','invalid fixture',1000000)")
          .run()
      );
      const response = yield* Effect.tryPromise(() => fixture.request());
      expect(response.status).toBe(503);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("freshly fences the atomic Category read after a recovery-generation change", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      expect((yield* Effect.tryPromise(() => fixture.request())).status).toBe(200);
      yield* Effect.tryPromise(() => fixture.bucket.put("recovery/generation", "restored"));
      fixture.generationReads.mockClear();
      const response = yield* Effect.tryPromise(() => fixture.request());
      expect(response.status).toBe(503);
      expect(fixture.generationReads).toHaveBeenCalled();
      expect(
        yield* Effect.tryPromise(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS total FROM audit_entries WHERE operation='categories.listCategories'"
            )
            .first()
        )
      ).toEqual({ total: 1 });
    })
  ));

it("does not replay Category work after losing an already committed native response", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      // Establish the recovery fence before injecting loss into the next owner batch.
      expect((yield* Effect.tryPromise(() => fixture.request())).status).toBe(200);
      let loseResponse = true;
      const native = new Proxy(fixture.db, {
        get: (target, property): unknown => {
          if (property === "batch") {
            return (statements: Array<D1PreparedStatement>): Promise<Array<D1Result>> =>
              target.batch(statements).then((rows) => {
                if (loseResponse) {
                  loseResponse = false;
                  throw new Error("Synthetic response loss after native commit");
                }
                return rows;
              });
          }
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      const request = new Request(
        `https://api.fidyapp.com${Option.getOrThrow(Option.fromUndefinedOr(getBoundOperationCatalog().byId.get("categories.listCategories"))).route}`,
        {
          headers: {
            cookie: `__Host-fidy_session=${fixture.token}`,
            [browserSessionBindingHeader]: fixture.sessionId,
          },
        }
      );
      const response = yield* Effect.tryPromise(() =>
        fixture.core(request, {
          ...fixture.environment,
          DB: maintenancePerformanceDatabase({ db: native, bucket: fixture.bucket }),
        })
      );
      expect(response.status).toBe(503);
      expect(loseResponse).toBe(false);
      expect(
        yield* Effect.tryPromise(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS total FROM audit_entries WHERE operation='categories.listCategories'"
            )
            .first()
        )
      ).toEqual({ total: 2 });
      expect(
        yield* Effect.tryPromise(() =>
          fixture.db.prepare("SELECT count(*) AS total FROM canonical_request_leases").first()
        )
      ).toEqual({ total: 0 });
      expect(
        yield* Effect.tryPromise(() =>
          fixture.db
            .prepare("SELECT count(*) AS total FROM commercial_allowance_consumptions")
            .first()
        )
      ).toEqual({ total: 0 });
    })
  ));
