import { deepStrictEqual } from "node:assert";
import { afterAll, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { handleWebAuthentication } from "./operations";
import { holdSessionCallback, seedSession, sessionRequest } from "./session.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

/** Observe the real native abort event without starting another Effect runtime. */
const awaitAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback((resume) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      resume(Effect.void);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    return Effect.sync(cleanup);
  });

it.effect.each([
  {
    stage: "idle renewal",
    sql: "UPDATE web_sessions SET idle_expires_at_ms",
    method: "first" as const,
    logout: false,
    audits: 0,
  },
  {
    stage: "current-user Audit",
    sql: "INSERT INTO canonical_user_reads",
    method: "run" as const,
    logout: false,
    audits: 1,
  },
  {
    stage: "logout revocation",
    sql: "UPDATE web_sessions SET revoked_at_ms",
    method: "run" as const,
    logout: true,
    audits: 0,
  },
])(
  "settles the started $stage callback before releasing cancelled authentication work",
  ({ sql, method, logout, audits }) => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seedSession({ db, idle: 4102444801000, hard: 4110220800000 });
      yield* TestClock.setTime(4102444800000);
      const held = yield* holdSessionCallback({ db, sqlPrefix: sql, method });
      const completed = yield* Deferred.make<Exit.Exit<Response>>();
      const requested = yield* Deferred.make<void>();
      const running = yield* Effect.forkChild(
        handleWebAuthentication(sessionRequest({ db: held.db, logout })).pipe(
          Effect.onExit((outcome) => Deferred.succeed(completed, outcome))
        )
      );
      const interrupting = yield* Effect.forkChild(
        awaitAbort(controller.signal).pipe(
          Effect.andThen(Deferred.succeed(requested, undefined)),
          Effect.andThen(Fiber.interruptAs(running, undefined))
        ),
        { startImmediately: true }
      );
      yield* Effect.gen(function* () {
        yield* Effect.raceFirst(
          Deferred.await(held.entered),
          Fiber.await(running).pipe(
            Effect.flatMap((outcome) =>
              Effect.die(
                new Error("Authentication exited before D1 callback readiness", { cause: outcome })
              )
            )
          )
        );
        controller.abort();
        yield* Deferred.await(requested);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(completed)).toBe(false);
        yield* held.release;
        deepStrictEqual(yield* Fiber.await(running), Exit.failCause(Cause.interrupt()));
        yield* Fiber.join(interrupting);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT revoked_at_ms, idle_expires_at_ms FROM web_sessions").first()
          )
        ).toEqual({
          revoked_at_ms: logout ? 4102444800000 : null,
          idle_expires_at_ms: logout ? 4102444801000 : 4105036800000,
        });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM canonical_user_reads").first()
          )
        ).toEqual({ count: audits });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* held.release;
            controller.abort();
            yield* Fiber.await(running);
            if (yield* Deferred.isDone(held.entered)) yield* Deferred.await(held.settled);
          })
        )
      );
    });
  }
);

it.effect(
  "cancels a held User projection without shielding the whole workflow or starting Audit",
  () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seedSession({ db, idle: 4102444801000, hard: 4110220800000 });
      yield* TestClock.setTime(4102444800000);
      const held = yield* holdSessionCallback({ db, sqlPrefix: "SELECT u.id", method: "all" });
      const running = yield* Effect.forkChild(
        handleWebAuthentication(sessionRequest({ db: held.db, logout: false }))
      );
      const interrupting = yield* Effect.forkChild(
        awaitAbort(controller.signal).pipe(Effect.andThen(Fiber.interruptAs(running, undefined))),
        { startImmediately: true }
      );
      yield* Effect.gen(function* () {
        yield* Effect.raceFirst(
          Deferred.await(held.entered),
          Fiber.await(running).pipe(
            Effect.flatMap((outcome) =>
              Effect.die(
                new Error("Authentication exited before User projection readiness", {
                  cause: outcome,
                })
              )
            )
          )
        );
        controller.abort();
        deepStrictEqual(yield* Fiber.await(running), Exit.failCause(Cause.interrupt()));
        yield* Fiber.join(interrupting);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM canonical_user_reads").first()
          )
        ).toEqual({ count: 0 });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* held.release;
            controller.abort();
            yield* Fiber.await(running);
            if (yield* Deferred.isDone(held.entered)) yield* Deferred.await(held.settled);
          })
        )
      );
    });
  }
);
