import { type Cause, Effect } from "effect";
import { type CoreHttpEnvironment } from "./contract";
import { it } from "@effect/vitest";
import { afterAll, expect, vi } from "vitest";
import { installCurrentTestObjects, isolatedTestDatabases } from "../d1-test-fixture";
import { makeCoreHttp } from "./runtime";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry/operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const database = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() =>
      installCurrentTestObjects({ db, tables: ["operational_event_buckets"] })
    );
    return db;
  });
const environment = (db: D1Database): CoreHttpEnvironment => ({
  DB: db,
  RELEASE_GIT_SHA: "0".repeat(40),
  CONTRACT_DIGEST: "0".repeat(64),
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  USER_TRANSACTION_COORDINATOR: {
    getByName: () => ({
      fetch: () => Promise.reject(new Error("No coordinator work authorized")),
    }),
  },
  KAPSO_API_KEY: "private-provider-key",
  KAPSO_WEBHOOK_SECRET: "private-webhook-secret",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "private-portfolio",
  CLOUDFLARE_ACCESS_ISSUER: "https://unused.example",
  CLOUDFLARE_ACCESS_AUDIENCE: "unused",
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_INTEGRITY_SECRET: "",
});

it.live("preserves actual Core callback refusals and never stores attacker request content", () =>
  Effect.gen(function* () {
    const db = yield* database();
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(Date, "now").mockReturnValue(1_800_000)),
      (clock) => Effect.sync(() => clock.mockRestore())
    );
    const core = makeCoreHttp(cloudflareWorkerTelemetry);
    const request = (): Request =>
      new Request("https://api.fidyapp.com/providers/kapso/callback?secret=private-query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-event": "whatsapp.message.received",
          "x-webhook-signature": "private-invalid-signature",
          authorization: "Bearer private-token",
        },
        body: '{"secret":"private-user-content"}',
      });
    let original = "";
    for (let count = 0; count < 101; count += 1) {
      const response = yield* Effect.tryPromise(() => core(request(), environment(db)));
      expect(response.status).toBe(401);
      const body = yield* Effect.tryPromise(() => response.text());
      if (count === 0) original = body;
      expect(body).toBe(original);
    }
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT 1 AS id,observed_at_ms FROM operational_event_buckets WHERE kind='core_rejection'"
        )
        .all()
    );
    expect(rows.results).toHaveLength(1);
    expect(Object.keys(rows.results[0] ?? {}).sort()).toEqual(["id", "observed_at_ms"]);
    expect(rows.results[0]).toEqual({ id: 1, observed_at_ms: 1_800_000 });
    yield* Effect.tryPromise(() => db.prepare("DROP TABLE operational_event_buckets").run());
    let failedWrites = 0;
    const failed = new Proxy(db, {
      get(target, key, receiver): unknown {
        if (key !== "prepare") return Reflect.get(target, key, receiver);
        return (sql: string) => {
          if (
            sql.startsWith(
              "INSERT INTO operational_event_buckets(kind,bucket_ms,count,observed_at_ms)"
            )
          ) {
            failedWrites += 1;
          }
          return db.prepare(sql);
        };
      },
    });
    const failingCore = makeCoreHttp(cloudflareWorkerTelemetry);
    for (let count = 0; count < 100; count += 1) {
      const response = yield* Effect.tryPromise(() => failingCore(request(), environment(failed)));
      expect(response.status).toBe(401);
      expect(yield* Effect.tryPromise(() => response.text())).toBe(original);
    }
    expect(failedWrites).toBe(1);
  })
);

it.live(
  "counts malformed provider callbacks without accepting forged boundary labels or path prefixes",
  () =>
    Effect.gen(function* () {
      const db = yield* database();
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(Date, "now").mockReturnValue(1_800_000)),
        (clock) => Effect.sync(() => clock.mockRestore())
      );
      const core = makeCoreHttp(cloudflareWorkerTelemetry);
      const send = (path: string): Promise<Response> =>
        core(
          new Request(`https://api.fidyapp.com${path}?private=callback`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-security-boundary": "mcp",
              "x-webhook-event": "private-unknown-event",
              "x-mcp-name": "private-forged-tool",
            },
            body: '{"boundary":"providerCallback","secret":"private-user-content"}',
          }),
          environment(db)
        );
      for (let index = 0; index < 100; index += 1) {
        const response = yield* Effect.tryPromise(() => send("/providers/kapso/callback-extra"));
        expect(response.status).toBe(404);
        yield* Effect.tryPromise(() => response.text());
      }
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT 1 AS id,observed_at_ms FROM operational_event_buckets WHERE kind='core_rejection'"
            )
            .all()
        )).results
      ).toEqual([]);
      for (let index = 0; index < 100; index += 1) {
        const response = yield* Effect.tryPromise(() => send("/providers/kapso/callback"));
        expect(response.status).toBe(422);
        yield* Effect.tryPromise(() => response.text());
      }
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT 1 AS id,observed_at_ms FROM operational_event_buckets WHERE kind='core_rejection'"
            )
            .all()
        )).results
      ).toEqual([{ id: 1, observed_at_ms: 1_800_000 }]);
    })
);
