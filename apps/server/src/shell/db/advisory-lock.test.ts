import { expect, it, layer } from "@effect/vitest";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Schedule } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  whatsAppCallerReference,
} from "~/core/identity/reference";
import { ApiHarness } from "~/shell/testing/api-harness";
import { MigrationSqlClient } from "./client";
import { advisoryLockKey, withUserTurnLock } from "./advisory-lock";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000a30");
const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000a31");

it("keeps unrelated slice locks distinct for the same User", () => {
  const keys = [
    advisoryLockKey.keywordRules(userId),
    advisoryLockKey.dashboard(userId),
    advisoryLockKey.hostedAttempt(userId),
    advisoryLockKey.consentSubject(userId),
    advisoryLockKey.whatsAppAdmission(userId),
  ].map(({ value, seed }) => `${seed}:${value}`);

  expect(new Set(keys).size).toBe(keys.length);
});

it("namespaces hosted-attempt serialization by User", () => {
  expect(advisoryLockKey.hostedAttempt(userId)).toEqual({
    value: `hosted-attempt:${userId}`,
    seed: 0,
  });
});

it("shares the bare User key only between WhatsApp admission and database claims", () => {
  expect(advisoryLockKey.whatsAppAdmission(userId)).toEqual({ value: userId, seed: 0 });
});

it("namespaces pre-subject Consent locks by both WhatsApp identity coordinates", () => {
  const caller = whatsAppCallerReference({
    businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-lock-test"),
    businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.LockTest"),
  });

  expect(advisoryLockKey.consentGate(caller)).toEqual({
    value: "consent-gate:portfolio-lock-test:CO.LockTest",
    seed: 0,
  });
});

const awaitHostedAttemptWaiter = (userId: UserId): Effect.Effect<void, never, MigrationSqlClient> =>
  Effect.gen(function* () {
    const migrationSql = yield* MigrationSqlClient;
    const lockKey = advisoryLockKey.hostedAttempt(userId);
    const waiters = yield* migrationSql<{ readonly present: number }>`
      SELECT 1 AS present
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND objsubid = 1
        AND classid = (
          (hashtextextended(${lockKey.value}, ${lockKey.seed}) >> 32) & 4294967295
        )::oid
        AND objid = (
          hashtextextended(${lockKey.value}, ${lockKey.seed}) & 4294967295
        )::oid
      LIMIT 1
    `;
    if (waiters.length === 0) {
      return yield* Effect.fail(undefined);
    }
  }).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }), Effect.orDie);

type HeldTurnLock = {
  readonly userId: UserId;
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
};

const holdTurnLock = ({
  userId,
  entered,
  release,
}: HeldTurnLock): Effect.Effect<void, never, SqlClient.SqlClient> =>
  withUserTurnLock(
    userId,
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  );

const sameUserSerializationProgram = Effect.scoped(
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const releaseSecond = yield* Deferred.make<void>();

    const first = yield* holdTurnLock({
      userId,
      entered: firstEntered,
      release: releaseFirst,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(firstEntered);
    const second = yield* holdTurnLock({
      userId,
      entered: secondEntered,
      release: releaseSecond,
    }).pipe(Effect.forkChild);

    yield* awaitHostedAttemptWaiter(userId);
    expect(yield* Deferred.isDone(secondEntered)).toBe(false);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Deferred.await(secondEntered);
    yield* Deferred.succeed(releaseSecond, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  })
);

const crossUserConcurrencyProgram = Effect.scoped(
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();

    const first = yield* holdTurnLock({
      userId,
      entered: firstEntered,
      release,
    }).pipe(Effect.forkChild);
    const second = yield* holdTurnLock({
      userId: otherUserId,
      entered: secondEntered,
      release,
    }).pipe(Effect.forkChild);

    yield* Deferred.await(firstEntered);
    yield* Deferred.await(secondEntered);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  })
);

const noLongTransactionProgram = Effect.scoped(
  Effect.gen(function* () {
    const migrationSql = yield* MigrationSqlClient;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* holdTurnLock({ userId, entered, release }).pipe(Effect.forkChild);
    yield* Deferred.await(entered);

    const lockKey = advisoryLockKey.hostedAttempt(userId);
    const rows = yield* migrationSql<{
      readonly state: string;
      readonly hasNoTransaction: boolean;
    }>`
      SELECT
        activity.state,
        activity.xact_start IS NULL AS "hasNoTransaction"
      FROM pg_locks AS lock
      JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
      WHERE lock.locktype = 'advisory'
        AND lock.granted
        AND lock.objsubid = 1
        AND lock.classid = (
          (hashtextextended(${lockKey.value}, ${lockKey.seed}) >> 32) & 4294967295
        )::oid
        AND lock.objid = (
          hashtextextended(${lockKey.value}, ${lockKey.seed}) & 4294967295
        )::oid
    `;
    expect(rows).toEqual([{ state: "idle", hasNoTransaction: true }]);
    yield* migrationSql`SELECT 1`;

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
  })
);

class ExpectedAttemptFailure extends Data.TaggedError("ExpectedAttemptFailure")<{}> {}

const assertDefect = (exit: Exit.Exit<unknown, unknown>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
};

const assertFreshTurnLockCanEnter = Effect.fnUntraced(function* () {
  let entered = false;
  yield* withUserTurnLock(
    userId,
    Effect.sync(() => {
      entered = true;
    })
  );
  expect(entered).toBe(true);
});

// Whatever ends the work the lock guards -- success, typed failure, defect, thrown defect, or
// interruption -- the next holder must be able to enter.
const releaseMatrixProgram = Effect.scoped(
  Effect.gen(function* () {
    yield* withUserTurnLock(userId, Effect.void);
    yield* assertFreshTurnLockCanEnter();

    const failed = yield* withUserTurnLock(userId, Effect.fail(new ExpectedAttemptFailure())).pipe(
      Effect.exit
    );
    expect(Exit.isFailure(failed)).toBe(true);
    yield* assertFreshTurnLockCanEnter();

    assertDefect(
      yield* withUserTurnLock(userId, Effect.die("expected hosted-turn defect")).pipe(Effect.exit)
    );
    yield* assertFreshTurnLockCanEnter();

    assertDefect(
      yield* withUserTurnLock(
        userId,
        Effect.sync((): never => {
          throw new Error("expected synchronous hosted-turn defect");
        })
      ).pipe(Effect.exit)
    );
    yield* assertFreshTurnLockCanEnter();

    const entered = yield* Deferred.make<void>();
    const fiber = yield* withUserTurnLock(
      userId,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    yield* assertFreshTurnLockCanEnter();
  })
);

const waitingCancellationProgram = Effect.scoped(
  Effect.gen(function* () {
    const holderEntered = yield* Deferred.make<void>();
    const releaseHolder = yield* Deferred.make<void>();
    const waitingEntered = yield* Deferred.make<void>();

    const holder = yield* holdTurnLock({
      userId,
      entered: holderEntered,
      release: releaseHolder,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(holderEntered);
    const waiter = yield* withUserTurnLock(
      userId,
      Deferred.succeed(waitingEntered, undefined)
    ).pipe(Effect.forkChild);
    yield* awaitHostedAttemptWaiter(userId);
    expect(yield* Deferred.isDone(waitingEntered)).toBe(false);

    yield* Effect.all([Fiber.interrupt(waiter), Deferred.succeed(releaseHolder, undefined)], {
      concurrency: "unbounded",
    });
    yield* Fiber.join(holder);
    yield* assertFreshTurnLockCanEnter();
  })
);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "withUserTurnLock",
  (it) => {
    it.effect(
      "serializes the same User across fresh module instances",
      () => sameUserSerializationProgram
    );
    it.effect(
      "allows different Users to overlap across fresh module instances",
      () => crossUserConcurrencyProgram
    );
    it.effect("holds the session lock without an open transaction", () => noLongTransactionProgram);
    it.effect(
      "releases serialization after success, typed failure, defect, and interruption",
      () => releaseMatrixProgram
    );
    it.effect(
      "cancels an advisory-lock wait without entering or poisoning the next attempt",
      () => waitingCancellationProgram
    );
  }
);
