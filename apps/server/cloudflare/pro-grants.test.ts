import assert from "node:assert/strict";
import { UserId } from "../src/core/identity/contract";
import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { executeProCommand } from "../src/shell/pro-grants/operations";
import { ProGrantFailure } from "../src/shell/pro-grants/contract";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";

const fromTestPromise = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
it.effect(
  "grants by signup email, refuses ambiguous identities without granting, and lists only active grants",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => databases.acquire());
      yield* fromTestPromise(() => installTestSchema({ db }));
      yield* fromTestPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(userA),
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(userB),
          db
            .prepare(
              "INSERT INTO provider_credentials(issuer,subject,user_id,contact_email,established_at_ms) VALUES('https://accounts.google.com','a',?,'tester@example.com',0)"
            )
            .bind(userA),
        ])
      );
      const run = (command: unknown): ReturnType<typeof executeProCommand> =>
        executeProCommand({
          command,
          operator: "operator",
          query: (statement) =>
            Effect.tryPromise({
              try: () =>
                db
                  .prepare(statement.sql)
                  .bind(...statement.params)
                  .all()
                  .then((result) => result.results),
              catch: () => new ProGrantFailure({ reason: "unavailable", candidates: [] }),
            }),
        });
      expect(yield* run({ action: "grant", selector: { email: "TESTER@example.com" } })).toEqual([
        { userId: userA, action: "grant" },
      ]);
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO provider_credentials(issuer,subject,user_id,contact_email,established_at_ms) VALUES('https://accounts.google.com','b',?,'tester@example.com',0)"
          )
          .bind(userB)
          .run()
      );
      const ambiguous = yield* Effect.exit(
        run({ action: "grant", selector: { email: "tester@example.com" } })
      );
      assert.deepStrictEqual(
        Exit.isFailure(ambiguous)
          ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(ambiguous.cause)))
          : ambiguous,
        Exit.fail(
          new ProGrantFailure({
            reason: "ambiguous-email",
            candidates: [UserId.make(userA), UserId.make(userB)],
          })
        )
      );
      expect(yield* run({ action: "list" })).toEqual([{ userId: userA, action: "grant" }]);
      expect(yield* run({ action: "revoke", selector: { userId: userA } })).toEqual([
        { userId: userA, action: "revoke" },
      ]);
      expect(yield* run({ action: "list" })).toEqual([]);
      yield* fromTestPromise(() =>
        expect(db.prepare("UPDATE pro_grant_events SET action='grant'").run()).rejects.toThrow()
      );
      expect(yield* run({ action: "list" })).toEqual([]);
    })
);
