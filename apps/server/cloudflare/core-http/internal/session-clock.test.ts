import { afterAll, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../../src/shell/observability/operations";
import { installTestSchema, isolatedTestDatabases } from "../../d1-test-fixture";
import type { CoreHttpEnvironment } from "../contract";
import { executeCoreHttp } from "./http";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

const userId = "10000000-0000-4000-8000-000000000001";
const pairingId = "20000000-0000-4000-8000-000000000001";
const sessionId = "30000000-0000-4000-8000-000000000001";
const token = "c".repeat(43);
const current = 946684800000;
const created = current - 1000;
const idleExpiry = current + 600000;
const hardExpiry = created + 7776000000;
const telemetry = makeTelemetryService(DisabledTelemetryResource.adapter);
const SessionTimes = Schema.Struct({
  created_at_ms: Schema.Int,
  fresh_until_ms: Schema.Int,
  idle_expires_at_ms: Schema.Int,
  hard_expires_at_ms: Schema.Int,
  revoked_at_ms: Schema.NullOr(Schema.Int),
});

for (const path of [
  "/web/hosted-turns",
  "/web/hosted-turns/progress",
  "/web/hosted-turns/delivery",
]) {
  it.effect(
    `validates malformed ${path} input when its cookie is live at the invocation Clock but expired at native time`,
    () =>
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* Effect.tryPromise(() =>
          installTestSchema({
            db,
            sources: Array.from(
              new Bun.Glob("*.sql").scanSync(new URL("../../migrations/", import.meta.url).pathname)
            )
              .sort()
              .map((name) => new URL(`../../migrations/${name}`, import.meta.url)),
          })
        );
        // The session's historical dates separate the two clocks without replacing native time.
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS current")
              .first<number>("current")
          )
        ).toBeGreaterThan(hardExpiry);
        const digest = new Uint8Array(
          yield* Effect.tryPromise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
          )
        );
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
              )
              .bind(userId, created),
            db
              .prepare(
                "INSERT INTO onboarding_consent_records VALUES (?, ?, '{}', 'disclosure', 'decision', ?, ?)"
              )
              .bind("clock-consent", userId, created, created),
            db
              .prepare(
                "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,?,?,?,'consumed',?,?)"
              )
              .bind(pairingId, "BCDF-GHJK", digest, userId, created, created + 600000),
            db
              .prepare(
                "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
              )
              .bind(
                sessionId,
                pairingId,
                userId,
                digest,
                created,
                created + 600000,
                idleExpiry,
                hardExpiry
              ),
          ])
        );
        let coordinatorAdmissions = 0;
        let publications = 0;
        const environment: CoreHttpEnvironment = {
          DB: db,
          RELEASE_GIT_SHA: "7011dc81cb77378388b2c269648e6379865f045b",
          CONTRACT_DIGEST: "0".repeat(64),
          USER_TRANSACTION_COORDINATOR: {
            getByName: () => {
              coordinatorAdmissions += 1;
              throw new Error("Malformed hosted input must not enter the User coordinator");
            },
          },
          KAPSO_API_KEY: "unused-clock-test",
          KAPSO_WEBHOOK_SECRET: "unused-clock-test",
          WHATSAPP_BUSINESS_PORTFOLIO_ID: "clock-test",
          CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
          CLOUDFLARE_ACCESS_AUDIENCE: "clock-test",
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          WOMPI_ENVIRONMENT: "sandbox",
          WOMPI_PUBLIC_KEY: "unused-clock-test",
          WOMPI_PRIVATE_KEY: "unused-clock-test",
          WOMPI_INTEGRITY_SECRET: "unused-clock-test",
        };
        yield* TestClock.setTime(current);
        const response = yield* executeCoreHttp({
          request: new Request(`https://api.fidyapp.com${path}`, {
            method: "POST",
            headers: {
              cookie: `__Host-fidy_session=${token}`,
              origin: environment.BROWSER_ORIGIN,
              "content-type": "application/json",
            },
            body: "{",
          }),
          environment,
          telemetry,
          publish: () => {
            publications += 1;
          },
        });
        const body = yield* Effect.tryPromise(() => response.json());
        const session = yield* Schema.decodeUnknownEffect(SessionTimes)(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms,revoked_at_ms FROM web_sessions WHERE id = ?"
              )
              .bind(sessionId)
              .first()
          )
        );
        expect(session).toEqual({
          created_at_ms: created,
          fresh_until_ms: created + 600000,
          idle_expires_at_ms: idleExpiry,
          hard_expires_at_ms: hardExpiry,
          revoked_at_ms: null,
        });
        expect(coordinatorAdmissions).toBe(0);
        expect(publications).toBe(0);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM hosted_turns").first<number>("count")
          )
        ).toBe(0);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM canonical_user_reads").first<number>("count")
          )
        ).toBe(0);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect({ status: response.status, body }).toEqual({
          status: 400,
          body: { status: "validation_failed" },
        });
      })
  );
}
