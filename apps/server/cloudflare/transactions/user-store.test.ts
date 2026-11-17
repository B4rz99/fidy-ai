import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import type { Miniflare } from "miniflare";
import { browserOrigins, productionTopology } from "../runtime/contract";
import { native, nativeUserPlatform } from "../user-store.test-fixture";

const alice = {
  user: "10000000-0000-4000-8000-000000000051",
  session: "10000000-0000-4000-8000-000000000061",
  bearer: "1".repeat(43),
};
const bob = {
  user: "10000000-0000-4000-8000-000000000052",
  session: "10000000-0000-4000-8000-000000000062",
  bearer: "2".repeat(43),
};
const category = "10000000-0000-4000-8000-000000000016";
const transaction = "10000000-0000-4000-8000-000000000088";
const second = "10000000-0000-4000-8000-000000000089";
const jsonBody = (response: Pick<Response, "json">): Effect.Effect<unknown> =>
  native(() => response.json());
const instant = 1_700_000_000_000;
const history = (
  runtime: Miniflare,
  subject = alice,
  query = ""
): Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>> =>
  native(() =>
    runtime.dispatchFetch(`https://${productionTopology.ingress.hostname}/transactions${query}`, {
      headers: {
        origin: browserOrigins.production,
        "Fidy-Session-Binding": subject.session,
        cookie: `__Host-fidy_session=${subject.bearer}`,
      },
    })
  );
const seed = Effect.fn(function* (runtime: Miniflare, subject: typeof alice) {
  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );
  const local = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: subject.user })
  );
  const digest = yield* native(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject.bearer))
  );
  const now = yield* Clock.currentTimeMillis;
  const exec = (
    ...args: Parameters<typeof local.exec>
  ): Effect.Effect<Awaited<ReturnType<typeof local.exec>>> => native(() => local.exec(...args));
  expect((yield* history(runtime, subject)).status).toBe(401);
  yield* native(() =>
    directory.exec(
      "INSERT INTO session_routes VALUES (?,?,?,?,?)",
      digest,
      subject.user,
      subject.session,
      "route-" + subject.session,
      now + 7776000000
    )
  );
  expect((yield* history(runtime, subject)).status).toBe(401);
  yield* exec(
    "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)",
    subject.user,
    now
  );
  yield* exec(
    "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)",
    subject.session,
    "10000000-0000-4000-8000-000000000071",
    subject.user,
    digest,
    now,
    now + 600000,
    now + 3600000,
    now + 7776000000
  );
  yield* exec("INSERT INTO categories VALUES (?,'Otros',1)", category);
  yield* exec(
    "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'9007199254740993.15','USD','outflow',?,?,?)",
    transaction,
    subject.user,
    category,
    instant,
    instant
  );
  return { exec, digest, directory, now };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "commits a complete, ordered browser history page with current standing and Audit",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const { exec } = yield* seed(runtime, alice);
        yield* exec(
          "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'25','COP','inflow',?,?,?)",
          second,
          alice.user,
          category,
          instant + 1000,
          instant
        );
        const first = yield* history(runtime, alice, "?limit=1");
        expect(first.status).toBe(200);
        expect(first.headers.get("fidy-canonical-allowance")).toBe("canonical_call");
        const page = yield* native(() => first.json());
        expect(page).toMatchObject({
          data: [{ id: second, money: { amount: "25", currency: "COP" } }],
          next: [{ tool: "transactions.listTransactions" }],
        });
        const cursor = encodeURIComponent(
          "2023-11-14T22:13:21.000Z|2023-11-14T22:13:20.000Z|" + second
        );
        const next = yield* history(runtime, alice, "?limit=1&cursor=" + cursor);
        expect(yield* native(() => next.json())).toMatchObject({
          data: [{ id: transaction, money: { amount: "9007199254740993.15", currency: "USD" } }],
          next: [],
        });
        const filtered = yield* history(runtime, alice, "?currency=USD&direction=inflow");
        expect(yield* native(() => filtered.json())).toEqual({ data: [], next: [] });
        expect(yield* exec("SELECT user_id,session_id,outcome FROM audit_entries")).toEqual(
          Array.from({ length: 3 }, () => ({
            user_id: alice.user,
            session_id: alice.session,
            outcome: "success",
          }))
        );
        expect(
          yield* exec("SELECT COUNT(*) AS spent FROM commercial_allowance_consumptions")
        ).toEqual([{ spent: 0 }]);
      })
  );

  test.effect(
    "refuses stale routes, foreign mounted sessions and revoked local authority without partial accountability",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const aliceStore = yield* seed(runtime, alice);
        const bobStore = yield* seed(runtime, bob);
        expect((yield* history(runtime, { ...alice, session: bob.session })).status).toBe(401);
        yield* native(() =>
          aliceStore.directory.exec(
            "UPDATE session_routes SET user_id=? WHERE token_digest=?",
            bob.user,
            aliceStore.digest
          )
        );
        expect((yield* history(runtime, alice)).status).toBe(401);
        yield* native(() =>
          aliceStore.directory.exec(
            "UPDATE session_routes SET user_id=? WHERE token_digest=?",
            alice.user,
            aliceStore.digest
          )
        );
        yield* aliceStore.exec(
          "UPDATE web_sessions SET revoked_at_ms=? WHERE id=?",
          aliceStore.now,
          alice.session
        );
        expect((yield* history(runtime, alice)).status).toBe(401);
        yield* bobStore.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES ('withdrawn',?,'processing_withdrawal',?)",
          bob.user,
          bobStore.now
        );
        expect((yield* history(runtime, bob)).status).toBe(401);
        for (const owner of [aliceStore, bobStore]) {
          expect(yield* owner.exec("SELECT COUNT(*) AS count FROM audit_entries")).toEqual([
            { count: 0 },
          ]);
          expect(
            yield* owner.exec("SELECT COUNT(*) AS count FROM canonical_request_buckets")
          ).toEqual([{ count: 0 }]);
        }
      })
  );

  test.effect(
    "rolls back a failed Audit and reopens the retained User store after process reconstruction",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* create();
            const { exec } = yield* seed(runtime, alice);
            yield* exec(
              "CREATE TRIGGER fail_read_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT,'fixture'); END"
            );
            const failure = yield* history(runtime, alice);
            expect(failure.status).toBe(503);
            expect(yield* jsonBody(failure)).toMatchObject({
              error: { code: "unavailable" },
              next: [],
            });
            expect(yield* exec("SELECT COUNT(*) AS count FROM audit_entries")).toEqual([
              { count: 0 },
            ]);
            expect(yield* exec("SELECT COUNT(*) AS count FROM canonical_request_buckets")).toEqual([
              { count: 0 },
            ]);
            yield* exec("DROP TRIGGER fail_read_audit");
          })
        );
        const runtime = yield* create();
        const fresh = yield* history(runtime, alice);
        expect(fresh.status).toBe(200);
        expect(yield* native(() => fresh.json())).toMatchObject({
          data: [{ id: transaction }],
        });
      })
  );

  test.effect(
    "reports an unavailable directory without disclosing records or treating the credential as invalid",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const { directory, exec } = yield* seed(runtime, alice);
        yield* native(() =>
          directory.exec("ALTER TABLE session_routes RENAME TO unavailable_routes")
        );
        const response = yield* history(runtime);
        expect(response.status).toBe(503);
        expect(yield* jsonBody(response)).toMatchObject({
          error: { code: "unavailable" },
          next: [],
        });
        expect(yield* exec("SELECT count(*) AS count FROM audit_entries")).toEqual([{ count: 0 }]);
      })
  );

  test.effect("isolates billing standing and enforces both native pressure limits", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform;
      const runtime = yield* create();
      const active = yield* seed(runtime, bob);
      const ordinary = yield* seed(runtime, alice);
      yield* active.exec(
        "UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?",
        active.now,
        active.now + 604800000,
        bob.user
      );
      expect((yield* history(runtime, bob)).headers.get("fidy-canonical-limit")).toBe("uncapped");
      expect((yield* history(runtime, alice)).headers.get("fidy-canonical-limit")).not.toBe(
        "uncapped"
      );
      yield* ordinary.exec(
        "UPDATE canonical_request_buckets SET virtual_at_ms=?",
        ordinary.now + 60000
      );
      expect((yield* history(runtime, alice)).status).toBe(429);
      yield* ordinary.exec("DELETE FROM canonical_request_buckets");
      yield* ordinary.exec(
        "INSERT INTO canonical_request_leases VALUES ('one',?,?),('two',?,?)",
        alice.user,
        ordinary.now + 60000,
        alice.user,
        ordinary.now + 60000
      );
      const limited = yield* history(runtime, alice);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("1");
      expect(yield* ordinary.exec("SELECT count(*) AS total FROM audit_entries")).toEqual([
        { total: 1 },
      ]);
      yield* ordinary.exec("UPDATE web_sessions SET idle_expires_at_ms=created_at_ms");
      expect((yield* history(runtime, alice)).status).toBe(401);
    })
  );

  for (const readiness of ["ready", "rebuilding", "absent"]) {
    test.effect(`reads complete effective facts with a ${readiness} projection`, () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const { exec, now } = yield* seed(runtime, alice);
        yield* exec("UPDATE transactions SET counterparty='shop',notes='corrected',revision=1");
        yield* exec(
          "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'9007199254740993.15','USD','outflow',?,?,?)",
          second,
          alice.user,
          category,
          instant,
          instant + 1
        );
        yield* exec(
          "INSERT INTO transaction_reconciliation_decisions VALUES (?,?,?,'linked',?,?)",
          alice.user,
          transaction,
          second,
          transaction,
          now
        );
        yield* exec(
          "UPDATE transactions SET reconciliation_first_id=?,reconciliation_second_id=? WHERE user_id=?",
          transaction,
          second,
          alice.user
        );
        yield* exec(
          "INSERT INTO transaction_projection_leaf(user_id,id,amount,currency,direction,category_id,counterparty,notes,occurred_at_ms,created_at_ms,revision) SELECT user_id,id,amount,currency,direction,category_id,counterparty,notes,occurred_at_ms,created_at_ms,revision FROM transaction_effective_source"
        );
        if (readiness !== "absent") {
          yield* exec(
            "INSERT INTO transaction_projection_state(user_id,version,readiness) VALUES (?,1,?)",
            alice.user,
            readiness
          );
        }
        const query =
          "?currency=USD&direction=outflow&counterparty=shop&from=2023-01-01T00:00:00Z&to=2024-01-01T00:00:00Z&limit=100";
        const matched = yield* history(runtime, alice, query);
        expect(matched.status).toBe(200);
        expect(yield* jsonBody(matched)).toMatchObject({
          data: [
            {
              id: transaction,
              counterparty: "shop",
              notes: "corrected",
              revision: 1,
              money: { amount: "9007199254740993.15", currency: "USD" },
            },
          ],
          next: [],
        });
        expect((yield* history(runtime, alice, "?limit=invalid")).status).toBe(400);
        expect((yield* history(runtime, alice, "?limit=2&limit=3")).status).toBe(400);
        if (readiness === "ready") {
          yield* exec("UPDATE transaction_projection_leaf SET amount='invalid-money'");
          const malformed = yield* history(runtime);
          expect(malformed.status).toBe(503);
          expect(yield* exec("SELECT count(*) AS total FROM audit_entries")).toEqual([
            { total: 3 },
          ]);
        }
      })
    );
  }
});
