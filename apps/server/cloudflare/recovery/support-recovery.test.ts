import { deepStrictEqual } from "node:assert";
import { Cause, Clock, Data, Effect, Exit, Fiber, Schema } from "effect";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import { startBrowserPairing } from "../browser-login/operations";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { handleSupportRecovery, issueInitialBackupRecoveryCode } from "./operations";
import type { SupportAccessConfiguration } from "./contract";

class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
const wait = <A>(run: () => Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
afterEach(() => vi.restoreAllMocks());
let sequence = 0;
const fetchUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.href;
};
const userId = Schema.decodeSync(UserId)("10000000-0000-4000-8000-000000000001");
const Pairing = Schema.Struct({ pairingId: Schema.String, publicCode: Schema.String });
const RecoveryBody = Schema.fromJsonString(
  Schema.Struct({
    pairingCode: Schema.String,
    backupRecoveryCode: Schema.String,
  })
);
const ownedClock = (live: Clock.Clock, current: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: current,
  currentTimeMillis: Effect.sync(current),
  currentTimeNanosUnsafe: () => BigInt(current()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(current()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) => live.sleep(duration),
});
type AssertionTimes = Readonly<{ issuedAt: number; expiresAt: number }>;
type Fixture = Readonly<{
  db: D1Database;
  pairingId: string;
  config: SupportAccessConfiguration;
  request: (assertion: string) => Request;
  assertion: (times: AssertionTimes) => Effect.Effect<string, TestFailure>;
  jwk: JWK;
}>;
const setup = (current: number): Effect.Effect<Fixture, TestFailure> =>
  Effect.gen(function* () {
    const db = yield* wait(() => databases.acquire());
    yield* wait(() =>
      installTestSchema({
        db,
        sources: [
          "0003_pending_consent",
          "0005_verified_onboarding",
          "0006_browser_login",
          "0007_browser_pairing_email",
          "0008_support_recovery",
        ].map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
      })
    );
    yield* wait(() =>
      db
        .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
        .bind(userId, current)
        .run()
    );
    const backupRecoveryCode = yield* wait(() =>
      issueInitialBackupRecoveryCode({
        db,
        userId,
        createdAtMs: current,
        commit: (credential) => db.batch([credential]).then(() => undefined),
      })
    );
    const pairing = yield* Schema.decodeUnknownEffect(Pairing)(
      yield* startBrowserPairing(db).pipe(
        Effect.flatMap((response) => wait(() => response.json())),
        Effect.mapError((cause) => new TestFailure({ cause }))
      )
    ).pipe(Effect.mapError((cause) => new TestFailure({ cause })));
    const config = {
      CLOUDFLARE_ACCESS_ISSUER: `https://support-clock-${++sequence}.cloudflareaccess.com`,
      CLOUDFLARE_ACCESS_AUDIENCE: "support-clock-audience",
    };
    const { publicKey, privateKey } = yield* wait(() => generateKeyPair("RS256"));
    const jwk: JWK = {
      ...(yield* wait(() => exportJWK(publicKey))),
      kid: "support-clock-key",
      alg: "RS256",
      use: "sig",
    };
    // Only the foreign key-fetch boundary is substituted; Jose still verifies the real signature.
    vi.spyOn(globalThis, "fetch").mockImplementation((input): Promise<Response> => {
      expect(fetchUrl(input)).toBe(`${config.CLOUDFLARE_ACCESS_ISSUER}/cdn-cgi/access/certs`);
      return Promise.resolve(Response.json({ keys: [jwk] }));
    });
    const body = yield* Schema.encodeEffect(RecoveryBody)({
      pairingCode: pairing.publicCode,
      backupRecoveryCode,
    }).pipe(Effect.mapError((cause) => new TestFailure({ cause })));
    return {
      db,
      pairingId: pairing.pairingId,
      config,
      jwk,
      request: (assertion): Request =>
        new Request("https://api.fidyapp.com/internal/support-recovery", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion },
          body,
        }),
      assertion: ({ issuedAt, expiresAt }): Effect.Effect<string, TestFailure> =>
        wait(() =>
          new SignJWT({})
            .setProtectedHeader({ alg: "RS256", kid: "support-clock-key" })
            .setIssuer(config.CLOUDFLARE_ACCESS_ISSUER)
            .setAudience(config.CLOUDFLARE_ACCESS_AUDIENCE)
            .setSubject("support-clock-operator")
            .setIssuedAt(issuedAt)
            .setExpirationTime(expiresAt)
            .sign(privateKey)
        ),
    };
  });

it("approves a valid assertion on the supplied Clock even when native JWT time considers it expired", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000 - 600000;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const assertion = yield* fixture.assertion({
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 300,
      });
      const response = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: fixture.db,
        config: fixture.config,
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(200);
      expect(yield* wait(() => response.json())).toEqual({ status: "approved" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(
        yield* wait(() =>
          fixture.db
            .prepare("SELECT state,user_id FROM browser_login_pairings WHERE id=?")
            .bind(fixture.pairingId)
            .first()
        )
      ).toEqual({ state: "ready", user_id: userId });
      expect(
        yield* wait(() =>
          fixture.db
            .prepare("SELECT consumed_at_ms FROM backup_recovery_credentials WHERE user_id=?")
            .bind(userId)
            .first()
        )
      ).toEqual({ consumed_at_ms: current });
      expect(
        (yield* wait(() =>
          fixture.db
            .prepare(
              "SELECT action,at_ms,user_id,operator_subject FROM support_recovery_events ORDER BY action"
            )
            .all()
        )).results
      ).toEqual([
        {
          action: "approved",
          at_ms: current,
          user_id: userId,
          operator_subject: "support-clock-operator",
        },
        {
          action: "opened",
          at_ms: current,
          user_id: userId,
          operator_subject: "support-clock-operator",
        },
      ]);
      expect(
        yield* wait(() => fixture.db.prepare("SELECT count(*) AS count FROM web_sessions").first())
      ).toEqual({ count: 0 });
    })
  ));

it.each(["owning Effect", "native Request"])(
  "initiates held support body cleanup on %s cancellation without a later recovery decision",
  (source) => {
    const ownerAbort = new AbortController();
    const requestAbort = new AbortController();
    const ready = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const cancelSettled = Promise.withResolvers<void>();
    let cancelStarted = false;
    return Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        const fixture = yield* setup(current);
        const assertion = yield* fixture.assertion({
          issuedAt: Math.floor(current / 1000),
          expiresAt: Math.floor(current / 1000) + 300,
        });
        const original = fixture.request(assertion);
        const bytes = new Uint8Array(yield* wait(() => original.arrayBuffer()));
        const request = new Request(original.url, {
          method: "POST",
          headers: original.headers,
          signal: requestAbort.signal,
          body: new ReadableStream<Uint8Array>(
            {
              pull(controller): Promise<void> {
                ready.resolve();
                return released.promise.then(() => {
                  if (!cancelStarted) {
                    controller.enqueue(bytes);
                    controller.close();
                  }
                });
              },
              cancel(): Promise<void> {
                cancelStarted = true;
                cancelled.resolve();
                return cancelSettled.promise;
              },
            },
            { highWaterMark: 0 }
          ),
        });
        const credential = yield* credentialSnapshot(fixture);
        const run = Effect.runPromiseExitWith(yield* Effect.context<never>());
        const pending = run(
          handleSupportRecovery({ request, db: fixture.db, config: fixture.config }),
          { signal: ownerAbort.signal }
        );
        yield* wait(() => ready.promise);
        if (source === "owning Effect") ownerAbort.abort();
        else {
          requestAbort.abort();
          yield* wait(() => cancelled.promise).pipe(Effect.timeout("250 millis"));
        }
        const exit = yield* wait(() => pending);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          // Retain fn stack annotations in the expected whole Exit, not just its interruption tag.
          deepStrictEqual(
            exit,
            Exit.failCause(Cause.annotate(Cause.interrupt(), Cause.annotations(exit.cause)))
          );
        }
        expect(cancelStarted).toBe(true);
        expect(request.body?.locked).toBe(false);
        expect(yield* credentialSnapshot(fixture)).toEqual(credential);
        expect(
          yield* wait(() =>
            fixture.db
              .prepare("SELECT state,user_id FROM browser_login_pairings WHERE id=?")
              .bind(fixture.pairingId)
              .first()
          )
        ).toEqual({ state: "pending_approval", user_id: null });
        // The operator admission completed before body acquisition; cancellation must not undo it.
        expect(
          yield* wait(() =>
            fixture.db.prepare("SELECT attempts FROM support_recovery_operator_limits").first()
          )
        ).toEqual({ attempts: 1 });
        for (const table of ["support_recovery_cases", "support_recovery_events", "web_sessions"]) {
          expect(
            yield* wait(() => fixture.db.prepare(`SELECT count(*) AS count FROM ${table}`).first())
          ).toEqual({ count: 0 });
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ownerAbort.abort();
            requestAbort.abort();
            released.resolve();
            cancelSettled.resolve();
          })
        )
      )
    );
  }
);

const credentialSnapshot = (fixture: Fixture): Effect.Effect<unknown, TestFailure> =>
  wait(() =>
    fixture.db
      .prepare(
        "SELECT code_digest,consumed_at_ms,revision FROM backup_recovery_credentials WHERE user_id=?"
      )
      .bind(userId)
      .first()
  );
const expectUnchanged = ({
  fixture,
  credential,
}: Readonly<{ fixture: Fixture; credential: unknown }>): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    expect(yield* credentialSnapshot(fixture)).toEqual(credential);
    expect(
      yield* wait(() =>
        fixture.db
          .prepare("SELECT state,user_id FROM browser_login_pairings WHERE id=?")
          .bind(fixture.pairingId)
          .first()
      )
    ).toEqual({ state: "pending_approval", user_id: null });
    for (const table of [
      "support_recovery_cases",
      "support_recovery_events",
      "support_recovery_operator_limits",
      "web_sessions",
    ]) {
      expect(
        yield* wait(() => fixture.db.prepare(`SELECT count(*) AS count FROM ${table}`).first())
      ).toEqual({ count: 0 });
    }
  });

it.each([
  {
    description:
      "refuses exact assertion expiry on the supplied Clock before consuming recovery proof",
    clockOffset: 300,
  },
  {
    description:
      "refuses future-issued assertions on the supplied Clock before consuming recovery proof",
    clockOffset: -60,
  },
])("$description", ({ clockOffset }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const nativeSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const current = (nativeSeconds + clockOffset) * 1000;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const credential = yield* credentialSnapshot(fixture);
      const assertion = yield* fixture.assertion({
        issuedAt: nativeSeconds,
        expiresAt: nativeSeconds + 300,
      });
      const response = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: fixture.db,
        config: fixture.config,
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(401);
      expect(yield* wait(() => response.json())).toEqual({ status: "unauthorized" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      yield* expectUnchanged({ fixture, credential });
    })
  )
);

it("refuses an assertion that expires on the supplied Clock while foreign key verification is held", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const credential = yield* credentialSnapshot(fixture);
      const expiresAt = current / 1000 + 300;
      const assertion = yield* fixture.assertion({ issuedAt: current / 1000, expiresAt });
      const requested = Promise.withResolvers<void>();
      const keys = Promise.withResolvers<Response>();
      vi.spyOn(globalThis, "fetch").mockImplementation((input): Promise<Response> => {
        expect(fetchUrl(input)).toBe(
          `${fixture.config.CLOUDFLARE_ACCESS_ISSUER}/cdn-cgi/access/certs`
        );
        requested.resolve();
        return keys.promise;
      });
      const pending = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: fixture.db,
        config: fixture.config,
      }).pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);
      yield* wait(() => requested.promise);
      current = expiresAt * 1000;
      keys.resolve(Response.json({ keys: [fixture.jwk] }));
      const response = yield* Fiber.join(pending);
      expect(response.status).toBe(401);
      expect(yield* wait(() => response.json())).toEqual({ status: "unauthorized" });
      yield* expectUnchanged({ fixture, credential });
    })
  ));
