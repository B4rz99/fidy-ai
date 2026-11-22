import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { expect } from "vitest";
import { alice, bob, makeNativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native, nativePurgePlatform } from "../user-store.test-fixture";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "expires only terminal support cases at 24 calendar months and retains consumed proof after a failed cleanup",
    () =>
      Effect.gen(function* () {
        const db = yield* makeNativeTransactionJourney(undefined, nativePurgePlatform);
        let leapYear = DateTime.getPartUtc(yield* DateTime.now, "year");

        while (DateTime.getPartUtc(DateTime.makeUnsafe(Date.UTC(leapYear, 1, 29)), "day") !== 29) {
          leapYear++;
        }

        const closed = Date.UTC(leapYear, 1, 29, 12, 1, 2, 345),
          deadline = Date.UTC(leapYear + 2, 1, 28, 12, 1, 2, 345);

        const cases = "SELECT id FROM support_recovery_cases ORDER BY id";

        yield* Effect.forEach(
          [alice, bob],
          Effect.fnUntraced(function* (person) {
            const store = db.owner(person.user);

            const insertCase = (): ReturnType<typeof store.exec> =>
              store.exec(
                "INSERT INTO support_recovery_cases(id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms) VALUES('case',?,'pair','issuer','subject',1,?,?,'approved',?)",
                person.user,
                closed,
                closed + 60000,
                closed
              );

            const insertCredential = (): ReturnType<typeof store.exec> =>
              store.exec(
                "INSERT OR REPLACE INTO backup_recovery_credentials(user_id,code_digest,created_at_ms,revision,consumed_at_ms) VALUES(?,zeroblob(32),?,1,?)",
                person.user,
                closed,
                closed
              );

            yield* native(insertCase);
            yield* native(insertCredential);
          }),
          { discard: true }
        );

        const owner = (yield* native(() =>
          db.runtime.getDurableObjectNamespace("USER_STORE", "core")
        )).getByName(alice.user);

        const alarm = (now: number): Effect.Effect<number> =>
          native(() =>
            owner.fetch("https://fixture.invalid/user-alarm", {
              method: "POST",
              headers: { "fixture-clock": String(now) },
            })
          ).pipe(Effect.map((reply) => reply.status));

        expect(yield* alarm(deadline - 1)).toBe(204);
        expect(yield* native(() => db.exec(cases))).toEqual([{ id: "case" }]);
        yield* native(() =>
          db.exec(
            "CREATE TRIGGER fail_case_retention BEFORE DELETE ON support_recovery_cases BEGIN SELECT RAISE(ABORT,'fixture'); END"
          )
        );
        expect(yield* alarm(deadline)).toBe(503);
        expect(yield* native(() => db.exec(cases))).toEqual([{ id: "case" }]);
        yield* native(() => db.exec("DROP TRIGGER fail_case_retention"));
        expect(yield* alarm(deadline)).toBe(204);
        expect(yield* native(() => db.exec(cases))).toEqual([]);
        expect(yield* native(() => db.owner(bob.user).exec(cases))).toEqual([{ id: "case" }]);
        expect(
          yield* native(() => db.exec("SELECT consumed_at_ms FROM backup_recovery_credentials"))
        ).toEqual([{ consumed_at_ms: closed }]);
      })
  );
});
