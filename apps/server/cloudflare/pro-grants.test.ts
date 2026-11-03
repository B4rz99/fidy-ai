import assert from "node:assert/strict";
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
  "refuses unverified provider contacts, grants only the verified mailbox owner, and lists active grants",
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
      const unverified = yield* Effect.exit(
        run({ action: "grant", selector: { email: "TESTER@example.com" } })
      );
      assert.deepStrictEqual(
        Exit.isFailure(unverified)
          ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(unverified.cause)))
          : unverified,
        Exit.fail(new ProGrantFailure({ reason: "user-not-found", candidates: [] }))
      );
      expect(yield* run({ action: "list" })).toEqual([]);
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO verified_email_credentials(user_id,address,verified_at_ms) VALUES(?,'tester@example.com',0)"
          )
          .bind(userB)
          .run()
      );
      expect(yield* run({ action: "grant", selector: { email: "TESTER@example.com" } })).toEqual([
        { userId: userB, action: "grant" },
      ]);
      expect(yield* run({ action: "list" })).toEqual([{ userId: userB, action: "grant" }]);
      expect(yield* run({ action: "revoke", selector: { userId: userB } })).toEqual([
        { userId: userB, action: "revoke" },
      ]);
      expect(yield* run({ action: "list" })).toEqual([]);
      expect(yield* run({ action: "grant", selector: { userId: userA } })).toEqual([
        { userId: userA, action: "grant" },
      ]);
      yield* run({ action: "revoke", selector: { userId: userA } });
      yield* fromTestPromise(() =>
        expect(db.prepare("UPDATE pro_grant_events SET action='grant'").run()).rejects.toThrow()
      );
      expect(yield* run({ action: "list" })).toEqual([]);
    })
);
