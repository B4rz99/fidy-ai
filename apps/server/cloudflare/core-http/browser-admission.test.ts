import { Clock, Effect, Option } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import { getBoundOperationCatalog } from "../../src/shell/canonical-catalog/contract";
import { browserSessionBindingHeader } from "../../src/shell/web-session/contract";
import { webAuthenticationEndpoints } from "../../src/shell/web-authentication/contract";
import { oauthPaths } from "../../src/shell/oauth-agents/contract";
import { installTestSchema, isolatedTestDatabases, isolatedTestStorage } from "../d1-test-fixture";
import { maintenancePerformanceDatabase } from "../maintenance-performance.test-fixture";
import { registeredConnectionInstitutionIds } from "../../src/shell/connections/contract";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry/operations";
import { type CoreHttpEnvironment } from "./contract";
import { makeCoreHttp } from "./runtime";

const databases = isolatedTestDatabases();
const storage = isolatedTestStorage();
afterAll(() => databases.dispose());
afterAll(() => storage.dispose());

it("serves a bound browser canonical read with three fresh recovery-generation checks", () =>
  Effect.runPromise(
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
      const operation = Option.getOrThrow(
        Option.fromUndefinedOr(getBoundOperationCatalog().byId.get("quota.getQuota"))
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
      expect(generationReads).toHaveBeenCalledTimes(3);
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
  ));
