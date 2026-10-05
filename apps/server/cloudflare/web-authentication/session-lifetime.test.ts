import { deepStrictEqual } from "node:assert";
import { Cause, Effect, Exit } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { handleWebAuthentication } from "./operations";
import {
  holdSessionCallback,
  seedSession,
  sessionRequest,
  withSessionTime,
} from "./session.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

it.each([
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
  async ({ sql, method, logout, audits }) => {
    const controller = new AbortController();
    const db = await databases.acquire();
    await seedSession(db);
    const held = holdSessionCallback(db, sql, method);
    let settled = false;
    const running = Effect.runPromiseExit(
      withSessionTime(handleWebAuthentication(sessionRequest(held.db, logout)), 4102444800000),
      {
        signal: controller.signal,
      }
    ).then((outcome) => {
      settled = true;
      return outcome;
    });
    try {
      await Promise.race([
        held.entered,
        running.then((outcome) => {
          throw new Error("Authentication exited before D1 callback readiness", { cause: outcome });
        }),
      ]);
      controller.abort();
      // Drain scheduled Effect/native continuations without a wall-clock timing assertion.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      held.release();
      controller.abort();
      const outcome = await running;
      deepStrictEqual(outcome, Exit.failCause(Cause.interrupt()));
    }
    expect(
      await db.prepare("SELECT revoked_at_ms, idle_expires_at_ms FROM web_sessions").first()
    ).toEqual({
      revoked_at_ms: logout ? 4102444800000 : null,
      idle_expires_at_ms: logout ? 4102444801000 : 4105036800000,
    });
    expect(await db.prepare("SELECT count(*) AS count FROM canonical_user_reads").first()).toEqual({
      count: audits,
    });
  }
);

it("cancels a held User projection without shielding the whole workflow or starting Audit", async () => {
  const controller = new AbortController();
  const db = await databases.acquire();
  await seedSession(db);
  const held = holdSessionCallback(db, "SELECT u.id", "all");
  const running = Effect.runPromiseExit(
    withSessionTime(handleWebAuthentication(sessionRequest(held.db)), 4102444800000),
    {
      signal: controller.signal,
    }
  );
  try {
    await Promise.race([
      held.entered,
      running.then((outcome) => {
        throw new Error("Authentication exited before User projection readiness", {
          cause: outcome,
        });
      }),
    ]);
    controller.abort();
    deepStrictEqual(await running, Exit.failCause(Cause.interrupt()));
    expect(await db.prepare("SELECT count(*) AS count FROM canonical_user_reads").first()).toEqual({
      count: 0,
    });
  } finally {
    held.release();
    controller.abort();
    await running;
  }
});
