import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import type { TelemetryWorkRecord } from "../src/shell/observability/contract";
import { makePublicWorker } from "./public-worker";
import { makeWorkerTelemetry } from "./runtime/telemetry/operations";

type Harness = Readonly<{
  records: TelemetryWorkRecord[];
  forwarded: string[];
  fetch: (path: string, init?: RequestInit) => Effect.Effect<Response, "request_failed">;
}>;

const harness = (): Harness => {
  const records: TelemetryWorkRecord[] = [];
  const forwarded: string[] = [];
  const worker = makePublicWorker(makeWorkerTelemetry((record) => records.push(record)));
  const environment: Parameters<typeof worker.fetch>[1] = {
    BROWSER_ORIGIN: "https://app.fidyapp.com",
    LOCAL_CANONICAL_READ_BEARER: "",
    PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CORE: {
      fetch: () => {
        forwarded.push("Core request");
        return Promise.resolve(new Response("unexpected Core request"));
      },
    },
  };
  return {
    records,
    forwarded,
    fetch: (path: string, init?: RequestInit): Effect.Effect<Response, "request_failed"> =>
      Effect.tryPromise({
        try: () => worker.fetch(new Request(`https://api.fidyapp.com${path}`, init), environment),
        catch: () => "request_failed" as const,
      }),
  };
};

it.effect("publishes an importable RSA signing key without private material or Core access", () =>
  Effect.gen(function* () {
    const app = harness();
    const response = yield* app.fetch("/connections/bancolombia/sandbox/jwks");
    expect(response.status).toBe(200);
    const jwks = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        keys: Schema.Tuple([
          Schema.Struct({
            alg: Schema.String,
            e: Schema.String,
            kid: Schema.String,
            kty: Schema.String,
            n: Schema.String,
            use: Schema.String,
          }),
        ]),
      })
    )(
      yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => "invalid_jwks_json" as const,
      }),
      { onExcessProperty: "error" }
    );
    const key = jwks.keys[0];
    expect(key).toMatchObject({ alg: "RS256", kty: "RSA", use: "sig", e: "AQAB" });
    expect(key.kid).toMatch(/^bancolombia-sandbox-/u);
    const imported = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
          "verify",
        ]),
      catch: () => "jwks_import_failed" as const,
    });
    const algorithm = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ modulusLength: Schema.Finite })
    )(imported.algorithm);
    expect(algorithm.modulusLength).toBeGreaterThanOrEqual(2048);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(app.forwarded).toEqual([]);
  })
);

it.effect("rejects callback form posts without reading or forwarding their credentials", () =>
  Effect.gen(function* () {
    const app = harness();
    const response = yield* app.fetch("/connections/bancolombia/sandbox/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=private-form-code&state=private-form-state",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => "response_read_failed" as const,
    });
    const observable = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      body,
      records: app.records,
    });
    expect(observable).not.toContain("private-form-code");
    expect(observable).not.toContain("private-form-state");
    expect(app.forwarded).toEqual([]);
  })
);

it.effect("keeps sandbox metadata inside the ingress origin and exact route policy", () =>
  Effect.gen(function* () {
    const app = harness();
    const hostile = yield* app.fetch("/connections/bancolombia/sandbox/jwks", {
      headers: { origin: "https://evil.example" },
    });
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("access-control-allow-origin")).toBeNull();
    const wrongMethod = yield* app.fetch("/connections/bancolombia/sandbox/jwks", {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(405);
    const lookalike = yield* app.fetch("/connections/bancolombia/production/jwks");
    expect(lookalike.status).toBe(404);
    expect(app.forwarded).toEqual([]);
  })
);

it.effect(
  "clears callback credentials and refuses authorization without forwarding or leaking them",
  () =>
    Effect.gen(function* () {
      const app = harness();
      const response = yield* app.fetch(
        "/connections/bancolombia/sandbox/callback?code=private-bank-code&state=private-bank-state&redirect_uri=https://evil.example"
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/connections/bancolombia/sandbox/callback");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const clean = yield* app.fetch("/connections/bancolombia/sandbox/callback");
      expect(clean.status).toBe(503);
      const body = yield* Effect.tryPromise({
        try: () => clean.text(),
        catch: () => "response_read_failed" as const,
      });
      expect(body).toContain("aún no está disponible");
      const observable = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        body,
        headers: [...response.headers],
        records: app.records,
      });
      expect(observable).not.toContain("private-bank-code");
      expect(observable).not.toContain("private-bank-state");
      expect(observable).not.toContain("evil.example");
      expect(app.forwarded).toEqual([]);
    })
);
