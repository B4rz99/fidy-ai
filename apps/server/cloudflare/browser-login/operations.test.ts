import { Deferred, Effect, Fiber, Schema } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { handleWebAuthentication } from "../web-authentication/operations";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../src/shell/observability/operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const telemetry = makeTelemetryService(DisabledTelemetryResource.adapter);
const support = {
  CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "support",
};
const pairingId = "30000000-0000-4000-8000-000000000001";

it("cancels a stalled browser redemption body when authentication is interrupted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const reading = yield* Deferred.make<void>();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (): void => {
            Deferred.doneUnsafe(reading, Effect.void);
          },
          cancel,
        },
        { highWaterMark: 0 }
      );
      const fiber = yield* Effect.forkChild(
        handleWebAuthentication({
          request: new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
          db,
          support,
          telemetry,
          publish: () => {},
        })
      );
      yield* Deferred.await(reading);
      yield* Fiber.interrupt(fiber);
      expect(body.locked).toBe(false);
      expect(cancel).toHaveBeenCalledOnce();
    })
  ));

it("reports corrupt retained pairing expiry as unavailable without consuming the pairing or creating a session", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const privateVerifier = "q".repeat(43);
      const digest = new Uint8Array(
        yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateVerifier))
        )
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE browser_login_pairings (id TEXT, state TEXT, user_id TEXT, expires_at_ms INTEGER, wrong_attempts INTEGER, verifier_digest BLOB, last_poll_at_ms INTEGER, minimum_poll_interval_seconds INTEGER)"
          ),
          db
            .prepare("INSERT INTO browser_login_pairings VALUES (?, 'ready', ?, ?, 0, ?, NULL, 5)")
            .bind(pairingId, "10000000-0000-4000-8000-000000000001", 8_640_000_000_000_001, digest),
          db.prepare("CREATE TABLE web_sessions (id TEXT)"),
        ])
      );
      const response = yield* handleWebAuthentication({
        request: new Request("https://api.fidyapp.com/web/pairings/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
            )
          )({ pairingId, privateVerifier }),
        }),
        db,
        support,
        telemetry,
        publish: () => {},
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM browser_login_pairings").first()
        )
      ).toEqual({ state: "ready" });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM web_sessions").first()
        )
      ).toEqual({ total: 0 });
    })
  ));
