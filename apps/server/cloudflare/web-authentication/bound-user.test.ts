import { type Cause, Clock, Deferred, Effect, Fiber, Schema } from "effect";
import { afterAll, expect, it } from "@effect/vitest";
import { User } from "../../src/core/identity/contract";
import { browserSessionBindingHeader } from "../../src/shell/web-session/contract";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../src/shell/observability/operations";
import {
  installCurrentTestObjects,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../d1-test-fixture";
import {
  holdSessionCallback,
  seedSession,
  sessionId,
  sessionToken,
  sessionUser,
} from "./session.test-fixture";
import { makeFixtureWorker } from "../core-worker.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const current = Effect.runSync(Clock.currentTimeMillis);
const idle = current + 60_000;
const hard = current + 7_776_000_000;
const telemetry = makeTelemetryService(DisabledTelemetryResource.adapter);
const core = makeFixtureWorker(telemetry);
const environment = (db: D1Database): Parameters<typeof core.fetch>[1] => ({
  DB: db,
  AI: { run: (): Promise<never> => Promise.reject(new Error("Unused model")) },
  HOSTED_AI_MODEL: "unused-bound-user-test",
  RELEASE_GIT_SHA: "0".repeat(40),
  CONTRACT_DIGEST: "0".repeat(64),
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  USER_TRANSACTION_COORDINATOR: {
    getByName: () => ({ fetch: () => Promise.reject(new Error("Unused coordinator")) }),
  },
  KAPSO_API_KEY: "unused-bound-user-test",
  KAPSO_WEBHOOK_SECRET: "unused-bound-user-test",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "unused-bound-user-test",
  CLOUDFLARE_ACCESS_ISSUER: "https://unused.example",
  CLOUDFLARE_ACCESS_AUDIENCE: "unused",
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_INTEGRITY_SECRET: "",
});

const setup = Effect.gen(function* () {
  const db = yield* Effect.tryPromise(() => databases.acquire());
  yield* Effect.tryPromise(() => installCurrentTestObjects({ db, tables: [] }));
  yield* seedSession({ db, idle, hard });
  return db;
});

const send = (db: D1Database, headers: Headers): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    core.fetch(new Request("https://api.fidyapp.com/user", { headers }), environment(db))
  );

const headers = (): Headers =>
  new Headers({
    cookie: `__Host-fidy_session=${sessionToken}`,
    [browserSessionBindingHeader]: sessionId,
  });

it.live("combines the current User binding proof with native idle renewal", () =>
  Effect.gen(function* () {
    const db = yield* setup;
    const observed = observeRetentionCost(db);
    const response = yield* send(observed.database, headers());
    expect(response.status).toBe(200);
    const body = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.toCodecJson(User) })
    )(yield* Effect.tryPromise(() => response.json()));
    expect(body.data.id).toBe(sessionUser);
    expect(observed.statements().length).toBe(3);
  })
);

const refusals = [
  "foreign binding",
  "malformed binding",
  "missing binding",
  "duplicate cookie",
  "foreign cookie",
  "revoked session",
  "expired idle",
  "expired hard",
  "mixed credential mismatch",
] as const;
type Refusal = (typeof refusals)[number];
const refusedHeaders = (refusal: Refusal): Headers => {
  const requestHeaders = headers();
  if (refusal === "foreign binding" || refusal === "mixed credential mismatch") {
    requestHeaders.set(browserSessionBindingHeader, "20000000-0000-4000-8000-000000000002");
  }
  if (refusal === "mixed credential mismatch") {
    requestHeaders.set("authorization", "Bearer unrelated-credential");
  }
  if (refusal === "malformed binding") requestHeaders.set(browserSessionBindingHeader, "invalid");
  if (refusal === "missing binding") requestHeaders.delete(browserSessionBindingHeader);
  if (refusal === "duplicate cookie") {
    requestHeaders.set(
      "cookie",
      `__Host-fidy_session=${sessionToken}; __Host-fidy_session=${sessionToken}`
    );
  }
  if (refusal === "foreign cookie") {
    requestHeaders.set("cookie", `__Host-fidy_session=${"d".repeat(43)}`);
  }
  return requestHeaders;
};

const invalidateSession = (
  db: D1Database,
  refusal: Refusal
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    if (refusal === "revoked session") {
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE web_sessions SET revoked_at_ms=?").bind(current).run()
      );
    }
    if (refusal === "expired idle") {
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE web_sessions SET idle_expires_at_ms=?").bind(current).run()
      );
    }
    if (refusal === "expired hard") {
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE web_sessions SET hard_expires_at_ms=?").bind(current).run()
      );
    }
  });

it.live.each(refusals)(
  "refuses %s without renewing the session or recording a User read",
  (refusal) =>
    Effect.gen(function* () {
      const db = yield* setup;
      yield* invalidateSession(db, refusal);
      const response = yield* send(db, refusedHeaders(refusal));
      expect(response.status).toBe(401);
      expect(yield* Effect.tryPromise(() => response.text())).not.toContain(sessionUser);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT idle_expires_at_ms FROM web_sessions").first("idle_expires_at_ms")
        )
      ).toBe(refusal === "expired idle" ? current : idle);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS n FROM audit_entries").first("n")
        )
      ).toBe(0);
    })
);

it.live("rechecks the bound session after the User projection completes", () =>
  Effect.gen(function* () {
    const db = yield* setup;
    const held = yield* holdSessionCallback({ db, sqlPrefix: "SELECT u.id", method: "all" });
    const running = yield* Effect.forkChild(send(held.db, headers()));
    yield* Effect.gen(function* () {
      yield* Deferred.await(held.entered);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE web_sessions SET revoked_at_ms=?").bind(current).run()
      );
    }).pipe(Effect.ensuring(held.release));
    const response = yield* Fiber.join(running);
    expect(response.status).toBe(401);
    expect(yield* Effect.tryPromise(() => response.text())).not.toContain(sessionUser);
    expect(
      yield* Effect.tryPromise(() =>
        db.prepare("SELECT count(*) AS n FROM audit_entries").first("n")
      )
    ).toBe(0);
  })
);
