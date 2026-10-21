import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Schema, type Scope } from "effect";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { RecoveryRetentionUnavailable, type SupportAccessConfiguration } from "./contract";
import { fixtureNativeHttpClient } from "../core-worker.test-fixture";
import { HttpClient } from "effect/http";
import { deepStrictEqual } from "node:assert";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import { startBrowserPairing } from "../browser-login/operations";
import { installTestSchema, isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import {
  handleSupportRecovery,
  issueInitialBackupRecoveryCode,
  retainedRecoveryPairingsQuery,
} from "./operations";
import { sweepRecoveryEvidence } from "./runtime";

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
type AssertionTimes = Readonly<{
  issuedAt: number;
  expiresAt: number;
  subject: Option.Option<string>;
}>;
type Fixture = Readonly<{
  db: D1Database;
  pairingId: string;
  config: SupportAccessConfiguration;
  request: (assertion: string) => Request;
  assertion: (times: AssertionTimes) => Effect.Effect<string, TestFailure>;
  jwk: JWK;
  httpClient: HttpClient.HttpClient;
}>;
const setup = (current: number): Effect.Effect<Fixture, TestFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const db = yield* wait(() => databases.acquire());
    yield* wait(() => installTestSchema({ db }));
    yield* wait(() =>
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
        )
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
      yield* startBrowserPairing({ db, retainedPairings: retainedRecoveryPairingsQuery() }).pipe(
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
      httpClient: yield* fixtureNativeHttpClient,
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

it("admits only five concurrent operator commands per rolling minute before body decoding", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 300,
      });
      const observed = observeRetentionCost(fixture.db);
      const invoke = (): Effect.Effect<Response> =>
        handleSupportRecovery({
          request: new Request(fixture.request(assertion), { method: "POST", body: "{}" }),
          db: observed.database,
          config: fixture.config,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
          Effect.provideService(Clock.Clock, clock)
        );
      const results = yield* Effect.all(Array.from({ length: 6 }, invoke), {
        concurrency: "unbounded",
      });
      expect(
        results.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([400, 400, 400, 400, 400, 429]);
      expect(observed.cost()).toEqual({ rowsRead: 59, rowsWritten: 20 });
      current += 60_000;
      expect((yield* invoke()).status).toBe(400);
      expect(observed.cost()).toEqual({ rowsRead: 73, rowsWritten: 24 });
    }).pipe(Effect.scoped)
  ));

const malformedCommand = (
  fixture: Fixture,
  assertion: string,
  clock: Clock.Clock
): Effect.Effect<Response> =>
  handleSupportRecovery({
    request: new Request(fixture.request(assertion), { method: "POST", body: "{}" }),
    db: fixture.db,
    config: fixture.config,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
    Effect.provideService(Clock.Clock, clock)
  );

it("enforces an operator rolling-hour limit independently of minute refills", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
      let current = started;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const sourceFixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const observed = observeRetentionCost(sourceFixture.db);
      const fixture = { ...sourceFixture, db: observed.database };
      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 900,
      });
      for (let minute = 0; minute < 4; minute++) {
        const responses = yield* Effect.all(
          Array.from({ length: 5 }, () => malformedCommand(fixture, assertion, clock)),
          { concurrency: "unbounded" }
        );
        expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400]);
        current += 60_000;
      }
      expect((yield* malformedCommand(fixture, assertion, clock)).status).toBe(429);

      current = started + 3_570_000;
      const outsider = yield* fixture.assertion({
        subject: Option.some("cleanup-foreign"),
        issuedAt: Math.floor(current / 1000),
        expiresAt: Math.floor(current / 1000) + 300,
      });
      expect((yield* malformedCommand(fixture, outsider, clock)).status).toBe(400);
      for (const boundary of [
        {
          offset: 3_599_999,
          status: 429,
          remaining: 21,
          costs: [
            { rowsRead: 1, rowsWritten: 0 },
            { rowsRead: 22, rowsWritten: 0 },
          ],
        },
        {
          offset: 3_600_000,
          status: 400,
          remaining: 17,
          costs: [
            { rowsRead: 6, rowsWritten: 5 },
            { rowsRead: 34, rowsWritten: 4 },
          ],
        },
      ]) {
        current = started + boundary.offset;
        const renewed = yield* fixture.assertion({
          subject: Option.none(),
          issuedAt: Math.floor(current / 1000),
          expiresAt: Math.floor(current / 1000) + 300,
        });
        const first = observed.statements().length;
        expect((yield* malformedCommand(fixture, renewed, clock)).status).toBe(boundary.status);
        const statements = observed.statements().slice(first);
        expect(statements.map(({ rowsRead, rowsWritten }) => ({ rowsRead, rowsWritten }))).toEqual(
          boundary.costs
        );
        expect(
          yield* wait(() =>
            fixture.db
              .prepare("SELECT count(*) AS remaining FROM support_recovery_admissions")
              .first()
          )
        ).toEqual({ remaining: boundary.remaining });
      }
      expect(
        yield* wait(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS remaining FROM support_recovery_admissions WHERE operator_subject='cleanup-foreign'"
            )
            .first()
        )
      ).toEqual({ remaining: 1 });
    }).pipe(Effect.scoped)
  ));

it("bounds verified recovery commands globally across operators and releases expired hourly admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
      let current = started;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const outsider = yield* fixture.assertion({
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 900,
        subject: Option.some("outsider"),
      });
      for (let minute = 0; minute < 5; minute++) {
        const assertions = yield* Effect.all(
          Array.from({ length: 4 }, (_, operator) =>
            fixture.assertion({
              issuedAt: current / 1000,
              expiresAt: current / 1000 + 900,
              subject: Option.some(`operator-${minute}-${operator}`),
            })
          )
        );
        const commands = assertions.flatMap((assertion) =>
          Array.from({ length: 5 }, () => malformedCommand(fixture, assertion, clock))
        );
        const responses = yield* Effect.all(commands, { concurrency: "unbounded" });
        expect(responses.every((response) => response.status === 400)).toBe(true);
        expect((yield* malformedCommand(fixture, outsider, clock)).status).toBe(429);
        current += 60_000;
      }
      expect((yield* malformedCommand(fixture, outsider, clock)).status).toBe(429);
      current = started + 3_600_000;
      const renewed = yield* fixture.assertion({
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 300,
        subject: Option.some("outsider"),
      });
      expect((yield* malformedCommand(fixture, renewed, clock)).status).toBe(400);
    }).pipe(Effect.scoped)
  ));

it("approves a valid assertion on the supplied Clock even when native JWT time considers it expired", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000 - 600000;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 300,
      });
      const observed = observeRetentionCost(fixture.db);
      const response = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: observed.database,
        config: fixture.config,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
        Effect.provideService(Clock.Clock, clock)
      );
      expect(response.status).toBe(200);
      const plans = yield* wait(observed.plans);
      const credentialPlans = plans.filter((plan) => plan.includes("backup_recovery_credentials"));
      expect(credentialPlans.length).toBeGreaterThan(0);
      expect(credentialPlans.every((plan) => plan.startsWith("SEARCH"))).toBe(true);
      expect(plans.some((plan) => /SEARCH b USING INDEX .*\(code_digest=\?\)/u.test(plan))).toBe(
        true
      );
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
              "SELECT action,at_ms,user_id,operator_subject FROM (SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery') ORDER BY action"
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
    }).pipe(Effect.scoped)
  ));

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
        const fixture = yield* setup(current);
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
        const credential = yield* credentialSnapshot(fixture);
        const pending = yield* handleSupportRecovery({
          request,
          db: fixture.db,
          config: fixture.config,
        }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.httpClient), Effect.forkChild);
        yield* wait(() => ready.promise);
        if (source === "owning Effect") yield* Fiber.interrupt(pending);
        else {
          requestAbort.abort();
          yield* wait(() => cancelled.promise).pipe(Effect.timeout("250 millis"));
        }
        const exit = yield* Fiber.await(pending);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
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
        expect(
          yield* wait(() =>
            fixture.db
              .prepare("SELECT count(*) AS attempts FROM support_recovery_admissions")
              .first()
          )
        ).toEqual({ attempts: 1 });
        for (const table of [
          "support_recovery_cases",
          "(SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery')",
          "web_sessions",
        ]) {
          expect(
            yield* wait(() => fixture.db.prepare(`SELECT count(*) AS count FROM ${table}`).first())
          ).toEqual({ count: 0 });
        }
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

const credentialSnapshot = (fixture: Fixture): Effect.Effect<unknown, TestFailure> =>
  wait(() =>
    fixture.db
      .prepare(
        "SELECT code_digest,consumed_at_ms,revision FROM backup_recovery_credentials WHERE user_id=?"
      )
      .bind(userId)
      .first()
  );

it.each([
  { description: "operator assertion", elapsedMs: 300_000, assertionSeconds: 300, status: 401 },
  { description: "browser pairing", elapsedMs: 600_000, assertionSeconds: 900, status: 400 },
])(
  "refuses recovery when its $description expires while reading the body",
  ({ elapsedMs, assertionSeconds, status }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        let current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
        const clock = ownedClock(yield* Clock.Clock, () => current);
        const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
        const credential = yield* credentialSnapshot(fixture);
        const assertion = yield* fixture.assertion({
          subject: Option.none(),
          issuedAt: current / 1000,
          expiresAt: current / 1000 + assertionSeconds,
        });
        const original = fixture.request(assertion);
        const bytes = new Uint8Array(yield* wait(() => original.arrayBuffer()));
        const reading = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const body = new ReadableStream<Uint8Array>(
          {
            pull: (controller): Promise<void> => {
              reading.resolve();
              return released.promise.then(() => {
                controller.enqueue(bytes);
                controller.close();
              });
            },
          },
          { highWaterMark: 0 }
        );
        const request = new Request(original.url, {
          method: "POST",
          headers: original.headers,
          body,
        });
        const pending = yield* handleSupportRecovery({
          request,
          db: fixture.db,
          config: fixture.config,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
          Effect.provideService(Clock.Clock, clock),
          Effect.forkChild
        );
        yield* wait(() => reading.promise);
        current += elapsedMs;
        released.resolve();
        const response = yield* Fiber.join(pending);
        expect(response.status).toBe(status);
        expect(yield* credentialSnapshot(fixture)).toEqual(credential);
        expect(
          yield* wait(() =>
            fixture.db.prepare("SELECT count(*) AS count FROM support_recovery_cases").first()
          )
        ).toEqual({ count: 0 });
      }).pipe(Effect.scoped)
    )
);

it("starts a new browser pairing after an approved recovery expires without browser redemption", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 300,
      });
      const approved = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: fixture.db,
        config: fixture.config,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
        Effect.provideService(Clock.Clock, clock)
      );
      expect(approved.status).toBe(200);
      current += 600_000;
      const next = yield* startBrowserPairing({
        db: fixture.db,
        retainedPairings: retainedRecoveryPairingsQuery(),
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(next.status).toBe(200);
      expect(
        yield* wait(() =>
          fixture.db.prepare("SELECT count(*) AS count FROM support_recovery_cases").first()
        )
      ).toEqual({ count: 1 });
      expect(
        yield* wait(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery')"
            )
            .first()
        )
      ).toEqual({ count: 2 });
    }).pipe(Effect.scoped)
  ));

it("retains recovery evidence until its calendar deadline then removes it without restoring consumed proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = Date.UTC(2024, 1, 29, 12);
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 300,
      });
      const approved = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: fixture.db,
        config: fixture.config,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
        Effect.provideService(Clock.Clock, clock)
      );
      expect(approved.status).toBe(200);
      const credential = yield* credentialSnapshot(fixture);
      yield* sweepRecoveryEvidence({ db: fixture.db, nowEpochMs: Date.UTC(2026, 1, 28, 12) - 1 });
      expect(
        yield* wait(() =>
          fixture.db.prepare("SELECT count(*) AS count FROM support_recovery_cases").first()
        )
      ).toEqual({ count: 1 });
      yield* sweepRecoveryEvidence({ db: fixture.db, nowEpochMs: Date.UTC(2026, 1, 28, 12) });
      for (const table of [
        "support_recovery_cases",
        "(SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery')",
      ]) {
        expect(
          yield* wait(() => fixture.db.prepare(`SELECT count(*) AS count FROM ${table}`).first())
        ).toEqual({ count: 0 });
      }
      expect(yield* credentialSnapshot(fixture)).toEqual(credential);
    }).pipe(Effect.scoped)
  ));
it("rolls back recovery event deletion when its terminal case cannot be removed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = Date.UTC(2024, 0, 1);
      const clock = ownedClock(yield* Clock.Clock, () => current);
      const fixture = yield* setup(current).pipe(Effect.provideService(Clock.Clock, clock));
      const assertion = yield* fixture.assertion({
        subject: Option.none(),
        issuedAt: current / 1000,
        expiresAt: current / 1000 + 300,
      });
      const approved = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: fixture.db,
        config: fixture.config,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
        Effect.provideService(Clock.Clock, clock)
      );
      expect(approved.status).toBe(200);
      const credential = yield* credentialSnapshot(fixture);
      yield* wait(() =>
        fixture.db.batch([
          fixture.db.prepare(
            "CREATE TABLE retained_case_dependency (case_id TEXT REFERENCES support_recovery_cases(id))"
          ),
          fixture.db.prepare(
            "INSERT INTO retained_case_dependency SELECT id FROM support_recovery_cases"
          ),
        ])
      );
      const exit = yield* Effect.exit(
        sweepRecoveryEvidence({ db: fixture.db, nowEpochMs: Date.UTC(2026, 0, 1) })
      );
      deepStrictEqual(exit, Exit.fail(new RecoveryRetentionUnavailable()));
      expect(
        yield* wait(() =>
          fixture.db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery')"
            )
            .first()
        )
      ).toEqual({ count: 2 });
      expect(
        yield* wait(() =>
          fixture.db.prepare("SELECT count(*) AS count FROM support_recovery_cases").first()
        )
      ).toEqual({ count: 1 });
      expect(yield* credentialSnapshot(fixture)).toEqual(credential);
    }).pipe(Effect.scoped)
  ));

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
      "(SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery')",
      "support_recovery_admissions",
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
        subject: Option.none(),
        issuedAt: nativeSeconds,
        expiresAt: nativeSeconds + 300,
      });
      const response = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: fixture.db,
        config: fixture.config,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
        Effect.provideService(Clock.Clock, clock)
      );
      expect(response.status).toBe(401);
      expect(yield* wait(() => response.json())).toEqual({ status: "unauthorized" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      yield* expectUnchanged({ fixture, credential });
    }).pipe(Effect.scoped)
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
      const pending = yield* handleSupportRecovery({
        request: fixture.request(assertion),
        db: fixture.db,
        config: fixture.config,
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
      yield* expectUnchanged({ fixture, credential });
    }).pipe(Effect.scoped)
  ));

it.each(["settled", "pending"] as const)(
  "rejects oversized streamed signing keys with %s cancellation before consuming recovery proof",
  (cancellation) => {
    const cancelSettled = Promise.withResolvers<void>();
    return Effect.runPromise(
      Effect.gen(function* () {
        const current = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
        const fixture = yield* setup(current);
        const credential = yield* credentialSnapshot(fixture);
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
        const response = yield* handleSupportRecovery({
          request,
          db: fixture.db,
          config: fixture.config,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, fixture.httpClient),
          Effect.timeout("1 second")
        );
        expect(response.status).toBe(401);
        expect(cancelled).toBe(true);
        expect(body.locked).toBe(false);
        expect(reader).not.toHaveBeenCalled();
        yield* expectUnchanged({ fixture, credential });
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
        const fixture = yield* setup(current);
        const credential = yield* credentialSnapshot(fixture);
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
        const pending = yield* handleSupportRecovery({
          request,
          db: fixture.db,
          config: fixture.config,
        }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.httpClient), Effect.forkChild);
        yield* wait(() => started.promise);
        if (owner === "request") {
          controller.abort();
          expect((yield* Fiber.join(pending)).status).toBe(401);
        } else {
          yield* Fiber.interrupt(pending);
        }
        expect(cancelled).toBe(true);
        expect(reader).not.toHaveBeenCalled();
        yield* expectUnchanged({ fixture, credential });
      }).pipe(Effect.scoped)
    );
  }
);
