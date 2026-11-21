import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  type Scope,
} from "effect";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { FetchHttpClient, HttpClient } from "effect/http";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { SupportAccessConfiguration } from "./contract";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { makeAccessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import { handleSupportProof } from "./internal/support-recovery";

const isRequest = Schema.is(Schema.instanceOf(Request));

class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}

const wait = <A>(run: () => Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) });

afterEach(() => vi.restoreAllMocks());

let sequence = 0;

const fetchUrl = (input: string | URL | Request): string => {
  if (Predicate.isString(input)) return input;

  if (isRequest(input)) return input.url;

  return input.href;
};

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

type AssertionTimes = Readonly<{
  issuedAt: number;
  expiresAt: number;
  subject: Option.Option<string>;
}>;

type Fixture = {
  admitted: number;
  approved: number;
  config: SupportAccessConfiguration;
  request: (assertion: string) => Request;
  assertion: (times: AssertionTimes) => Effect.Effect<string, TestFailure>;
  jwk: JWK;
  httpClient: HttpClient.HttpClient;
};

const setup = (): Effect.Effect<Fixture, TestFailure, Scope.Scope> =>
  Effect.gen(function* () {
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

    vi.spyOn(globalThis, "fetch").mockImplementation((input): Promise<Response> => {
      expect(fetchUrl(input)).toBe(`${config.CLOUDFLARE_ACCESS_ISSUER}/cdn-cgi/access/certs`);

      return Promise.resolve(Response.json({ keys: [jwk] }));
    });

    const body = yield* Schema.encodeEffect(RecoveryBody)({
      pairingCode: "BCDF-GHJK",
      backupRecoveryCode: "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2",
    }).pipe(Effect.mapError((cause) => new TestFailure({ cause })));

    const clients = yield* Layer.build(OutboundHttpLive).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
    );

    return {
      admitted: 0,
      approved: 0,
      config,
      jwk,
      httpClient: Context.get(clients, HttpClient.HttpClient),
      request: (assertion): Request =>
        new Request("https://api.fidyapp.com/internal/support-recovery", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion },
          body,
        }),
      assertion: ({ issuedAt, expiresAt, subject }): Effect.Effect<string, TestFailure> =>
        wait(() =>
          new SignJWT({})
            .setProtectedHeader({ alg: "RS256", kid: "support-clock-key" })
            .setIssuer(config.CLOUDFLARE_ACCESS_ISSUER)
            .setAudience(config.CLOUDFLARE_ACCESS_AUDIENCE)
            .setSubject(Option.getOrElse(subject, () => "support-clock-operator"))
            .setIssuedAt(issuedAt)
            .setExpirationTime(expiresAt)
            .sign(privateKey)
        ),
    };
  });

const checkProof = Effect.fn(function* ({
  request,
  fixture,
}: {
  request: Request;
  fixture: Fixture;
}) {
  return yield* handleSupportProof({
    request,
    config: fixture.config,
    http: makeAccessSigningKeysOutboundHttp({
      issuer: fixture.config.CLOUDFLARE_ACCESS_ISSUER,
      httpClient: yield* HttpClient.HttpClient,
    }),
    admit: () => {
      fixture.admitted++;

      return Promise.resolve("allowed");
    },
    approve: () => {
      fixture.approved++;

      return Promise.resolve(Response.json({ status: "approved" }));
    },
  });
});

it.each(["owning Effect", "native Request"])(
  "initiates held support body cleanup on %s cancellation without a later recovery decision",
  (source) => {
    const requestAbort = new AbortController();
    const ready = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const cancelSettled = Promise.withResolvers<void>();
    let cancelStarted = false;

    return Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        const fixture = yield* setup();

        const assertion = yield* fixture.assertion({
          subject: Option.none(),
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

        const pending = yield* checkProof({
          request,
          fixture,
        }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.httpClient), Effect.forkChild);

        yield* wait(() => ready.promise);

        if (source === "owning Effect") yield* Fiber.interrupt(pending);
        else {
          requestAbort.abort();
          yield* wait(() => cancelled.promise).pipe(Effect.timeout("250 millis"));
        }

        const exit = yield* Fiber.await(pending);
        expect(Exit.isFailure(exit)).toBe(true);

        assert(Exit.isFailure(exit));
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);

        expect(cancelStarted).toBe(true);
        expect(request.body?.locked).toBe(false);
        expect(fixture.admitted).toBe(1);
        expect(fixture.approved).toBe(0);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            requestAbort.abort();
            released.resolve();
            cancelSettled.resolve();
          })
        ),
        Effect.scoped
      )
    );
  }
);

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
      const fixture = yield* setup().pipe(Effect.provideService(Clock.Clock, clock));

      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: nativeSeconds,
        expiresAt: nativeSeconds + 300,
      });

      const response = yield* checkProof({
        request: fixture.request(assertion),
        fixture,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
        Effect.provideService(Clock.Clock, clock)
      );

      expect(response.status).toBe(401);
      expect(yield* wait(() => response.json())).toEqual({ status: "unauthorized" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(fixture.admitted).toBe(0);
      expect(fixture.approved).toBe(0);
    }).pipe(Effect.scoped)
  )
);

it("refuses an assertion that expires on the supplied Clock while foreign key verification is held", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup().pipe(Effect.provideService(Clock.Clock, clock));

      const expiresAt = current / 1000 + 300;

      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: current / 1000,
        expiresAt,
      });

      const requested = Promise.withResolvers<void>();
      const keys = Promise.withResolvers<Response>();
      vi.spyOn(globalThis, "fetch").mockImplementation((input): Promise<Response> => {
        expect(fetchUrl(input)).toBe(
          `${fixture.config.CLOUDFLARE_ACCESS_ISSUER}/cdn-cgi/access/certs`
        );
        requested.resolve();

        return keys.promise;
      });

      const pending = yield* checkProof({
        request: fixture.request(assertion),
        fixture,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
        Effect.provideService(Clock.Clock, clock),
        Effect.forkChild
      );

      yield* wait(() => requested.promise);
      current = expiresAt * 1000;
      keys.resolve(Response.json({ keys: [fixture.jwk] }));
      const response = yield* Fiber.join(pending);
      expect(response.status).toBe(401);
      expect(yield* wait(() => response.json())).toEqual({ status: "unauthorized" });
      expect(fixture.admitted).toBe(0);
      expect(fixture.approved).toBe(0);
    }).pipe(Effect.scoped)
  ));

it.each(["settled", "pending"] as const)(
  "rejects oversized streamed signing keys with %s cancellation before consuming recovery proof",
  (cancellation) => {
    const cancelSettled = Promise.withResolvers<void>();

    return Effect.runPromise(
      Effect.gen(function* () {
        const current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
        const fixture = yield* setup();

        const assertion = yield* fixture.assertion({
          subject: Option.none(),
          issuedAt: current / 1000,
          expiresAt: current / 1000 + 300,
        });

        let cancelled = false;

        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller): void {
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel(): Promise<void> {
              cancelled = true;

              return cancellation === "pending" ? cancelSettled.promise : Promise.resolve();
            },
          },
          { highWaterMark: 0 }
        );

        vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(body)));
        const request = fixture.request(assertion);

        if (request.body === null) throw new Error("Expected request body");
        const reader = vi.spyOn(request.body, "getReader");

        const response = yield* checkProof({
          request,
          fixture,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
          Effect.timeout("1 second")
        );

        expect(response.status).toBe(401);
        expect(cancelled).toBe(true);
        expect(body.locked).toBe(false);
        expect(reader).not.toHaveBeenCalled();
        expect(fixture.admitted).toBe(0);
        expect(fixture.approved).toBe(0);
      }).pipe(Effect.ensuring(Effect.sync(() => cancelSettled.resolve())), Effect.scoped)
    );
  }
);

it.each(["request", "fiber"] as const)(
  "cancels pending signing-key retrieval with its owning %s",
  (owner) => {
    const controller = new AbortController();

    return Effect.runPromise(
      Effect.gen(function* () {
        const current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
        const fixture = yield* setup();

        const assertion = yield* fixture.assertion({
          subject: Option.none(),
          issuedAt: current / 1000,
          expiresAt: current / 1000 + 300,
        });

        const started = Promise.withResolvers<void>();
        let cancelled = false;
        vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
          const result = Promise.withResolvers<Response>();
          init?.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              result.reject(new Error("aborted"));
            },
            { once: true }
          );
          started.resolve();

          return result.promise;
        });
        const request = new Request(fixture.request(assertion), { signal: controller.signal });

        if (request.body === null) throw new Error("Expected request body");
        const reader = vi.spyOn(request.body, "getReader");

        const pending = yield* checkProof({
          request,
          fixture,
        }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.httpClient), Effect.forkChild);

        yield* wait(() => started.promise);

        const status = yield* owner === "request"
          ? Effect.sync(() => controller.abort()).pipe(
              Effect.andThen(Fiber.join(pending)),
              Effect.map((response) => Option.some(response.status))
            )
          : Fiber.interrupt(pending).pipe(Effect.as(Option.none()));

        expect(status).toEqual(owner === "request" ? Option.some(401) : Option.none());

        expect(cancelled).toBe(true);
        expect(reader).not.toHaveBeenCalled();
        expect(fixture.admitted).toBe(0);
        expect(fixture.approved).toBe(0);
      }).pipe(Effect.scoped)
    );
  }
);

it("accepts a signed support assertion on the composing Clock and authorizes exactly one decision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 600;
      const clock = ownedClock(yield* Clock.Clock, () => now * 1000);
      const fixture = yield* setup();

      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: now,
        expiresAt: now + 300,
      });

      const response = yield* checkProof({ request: fixture.request(assertion), fixture }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
        Effect.provideService(Clock.Clock, clock)
      );

      expect(response.status).toBe(200);
      expect([fixture.admitted, fixture.approved]).toEqual([1, 1]);
    }).pipe(Effect.scoped)
  ));
