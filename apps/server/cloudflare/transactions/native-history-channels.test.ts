import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { HostedTurnProcessing, HostedTurnProposal } from "../../src/shell/agent/contract";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import {
  alice,
  bob,
  category,
  makeNativeTransactionJourney,
  nativeBrowserWrite,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native, nativeHostedPlatform } from "../user-store.test-fixture";

const token = "fin_qqqqqqqq_" + "p".repeat(43);

const own = "70000000-0000-4000-8000-000000000001",
  foreign = "70000000-0000-4000-8000-000000000002";

const setup = Effect.fn(function* (corrupt: boolean = false) {
  const db = yield* makeNativeTransactionJourney(undefined, nativeHostedPlatform);
  const current = yield* Clock.currentTimeMillis;

  const snapshot = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    currentDisclosureFor()
  );

  yield* native(() =>
    db.exec(
      "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000"
    )
  );
  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
      bob.user,
      alice.user,
      current,
      snapshot
    )
  );
  yield* seedNativePAT({ db, userId: alice.user, token, scopes: ["read"], current });

  const insert =
    "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,notes,occurred_at_ms,created_at_ms) VALUES(?,?,?,?,'outflow',?,'Pago literal',1736510400000,1736510400000)";

  yield* native(() =>
    db.exec(insert, corrupt ? "invalid-retained-id" : own, alice.user, "12.34", "USD", category)
  );
  yield* native(() => db.owner(bob.user).exec(insert, foreign, bob.user, "99", "COP", category));

  const patRead = (path: string): Effect.Effect<Response> =>
    native(() =>
      db.send(
        new Request("https://api.fidyapp.com" + path, {
          headers: { authorization: "Bearer " + token },
        })
      )
    );

  return { db, patRead };
});

const cases = [
  {
    op: "listTransactions",
    args: { query: { direction: "outflow", currency: "USD" } },
    path: "/transactions?direction=outflow&currency=USD",
  },
  {
    op: "searchTransactions",
    args: { query: { q: "Pago literal" } },
    path: "/transactions/search?q=Pago%20literal",
  },
  {
    op: "searchTransactions",
    args: {
      query: {
        q: "Pago literal",
        currency: "USD",
        direction: "outflow",
        amount: "12.340",
        limit: "1",
      },
    },
    path: "/transactions/search?q=Pago%20literal&currency=USD&direction=outflow&amount=12.340&limit=1",
  },
  { op: "getTransaction", args: { params: { id: foreign } }, path: "/transactions/" + foreign },
] as const;

const hosted = Effect.fn(function* (
  db: Effect.Success<ReturnType<typeof setup>>["db"],
  calls: ReadonlyArray<{ op: string; args: unknown }>,
  fails: boolean = false
) {
  const ns = yield* native(() =>
      db.runtime.getDurableObjectNamespace("CONTROL", "hosted-provider")
    ),
    provider = ns.getByName("provider");

  yield* native(() =>
    provider.fetch("https://fixture.invalid/tools", {
      method: "POST",
      body: JSON.stringify(
        calls.map((entry) => ({
          name: "transactions__" + entry.op,
          arguments: JSON.stringify(entry.args),
        }))
      ),
    })
  );
  const send = nativeBrowserWrite(db);

  const admitted = yield* send(alice, {
    path: "/web/hosted-turns",
    method: "POST",
    body: { text: "Consulta mis movimientos." },
  });

  expect(admitted.status).toBe(202);

  const { turnId } = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
    yield* native(() => admitted.json())
  );

  yield* native(() => provider.fetch("https://fixture.invalid/release"));
  yield* Effect.retry(
    Effect.gen(function* () {
      const reply = yield* send(alice, {
        path: "/web/hosted-turns/progress",
        method: "POST",
        body: { turnId },
      });

      if (!fails) {
        yield* Schema.decodeUnknownEffect(HostedTurnProposal)(yield* native(() => reply.json()));

        return;
      }

      if (reply.status !== 503) return yield* Effect.fail("awaiting terminal refusal");
      expect(yield* native(() => reply.json())).toEqual({ status: "interrupted" });
    }),
    { times: 50, schedule: Schedule.spaced("50 millis") }
  );

  return yield* native(() =>
    db.exec(
      "SELECT json_extract(entry_json,'$.outcome._tag') AS outcome,json_extract(entry_json,'$.outcome.output') AS output FROM hosted_transcript WHERE turn_id=? AND json_extract(entry_json,'$._tag')='CanonicalToolResultEntry' ORDER BY sequence",
      turnId
    )
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "returns matching exact filtered history through PAT and hosted tools, isolating foreign rows and attributing each call to its actor",
    Effect.fnUntraced(function* () {
      const { db, patRead } = yield* setup();
      const rows = yield* hosted(db, cases);
      expect(rows).toHaveLength(cases.length);

      yield* Effect.forEach(
        cases.entries(),
        Effect.fnUntraced(function* ([index, entry]) {
          const response = yield* patRead(entry.path);

          const missing = entry.op === "getTransaction";
          expect(response.status).toBe(missing ? 404 : 200);
          yield* Effect.sync(() => {
            expect(rows[index]?.outcome).toBe("CanonicalOperationFailed");
          }).pipe(Effect.when(Effect.succeed(missing)));

          if (missing) return;
          const body = yield* native(() => response.json());
          expect(body).toMatchObject({
            data: [{ id: own, money: { amount: "12.34", currency: "USD" } }],
          });

          const output = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
            rows[index]?.output
          );

          expect(output).toEqual(body);
        }),
        { discard: true }
      );

      expect(
        yield* native(() =>
          db.exec(
            "SELECT count(*) AS n FROM audit_entries WHERE pat_id IS NOT NULL AND record_type='credential_call'"
          )
        )
      ).toEqual([{ n: 4 }]);
      expect(
        yield* native(() =>
          db.exec("SELECT count(*) AS n FROM pats WHERE last_used_at_ms IS NOT NULL")
        )
      ).toEqual([{ n: 1 }]);
      expect((yield* patRead("/transactions/not-an-id")).status).toBe(404);
      expect((yield* native(() => db.browser(0, "/transactions/not-an-id"))).status).toBe(404);
      expect(
        yield* native(() =>
          db.exec(
            "SELECT operation,outcome FROM audit_entries WHERE record_type='session_call' AND operation='transactions.getTransaction'"
          )
        )
      ).toEqual([{ operation: "transactions.getTransaction", outcome: "not_found" }]);
      expect(
        yield* native(() => db.owner(bob.user).exec("SELECT count(*) AS n FROM audit_entries"))
      ).toEqual([{ n: 0 }]);
    })
  );
  test.effect.each(["corrupt", "unavailable", "revoked"] as const)(
    "preserves the %s history refusal and atomic credential accounting at the native owner",
    (kind) =>
      Effect.gen(function* () {
        const { db, patRead } = yield* setup(kind === "corrupt");

        if (kind === "unavailable") {
          yield* native(() =>
            db.exec(
              "CREATE TRIGGER refuse_history_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END"
            )
          );
        }

        if (kind === "revoked") {
          yield* native(() => db.exec("UPDATE pats SET revoked_at_ms=created_at_ms+1"));
        }

        const response = yield* patRead(cases[0].path);
        expect(response.status).toBe(kind === "revoked" ? 401 : 503);
        expect(
          yield* native(() =>
            db.exec("SELECT count(*) AS n FROM audit_entries WHERE record_type='credential_call'")
          )
        ).toEqual([{ n: 0 }]);
        expect(
          yield* native(() =>
            db.exec("SELECT count(*) AS n FROM pats WHERE last_used_at_ms IS NOT NULL")
          )
        ).toEqual([{ n: 0 }]);
        const results = yield* hosted(db, [cases[0]], kind === "corrupt");

        expect(results.map((result) => result.outcome)).toEqual(
          kind === "corrupt" ? [] : ["Succeeded"]
        );

        const hostedTurns = native(() =>
          db.exec("SELECT state,answer,receipt_digest FROM hosted_turns")
        );

        yield* Effect.gen(function* () {
          expect(yield* hostedTurns).toEqual([
            { state: "failed", answer: null, receipt_digest: null },
          ]);
        }).pipe(Effect.when(Effect.succeed(kind === "corrupt")));

        expect(yield* native(() => db.exec("SELECT count(*) AS n FROM transactions"))).toEqual([
          { n: 1 },
        ]);
        expect(yield* native(() => db.owner(bob.user).exec("SELECT id FROM transactions"))).toEqual(
          [{ id: foreign }]
        );
      })
  );
});
