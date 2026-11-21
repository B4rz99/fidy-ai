import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Option, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import type { Miniflare } from "miniflare";
import { browserOrigins, productionTopology } from "../runtime/contract";
import { native, nativeCapacityPlatform, nativeUserPlatform } from "../user-store.test-fixture";

import {
  alice,
  bob,
  category,
  history,
  instant,
  nativeIngress,
  receivedStatus,
  second,
  seed,
  transaction,
} from "../financial-user-store.test-fixture";

const jsonBody = (response: Pick<Response, "json">): Effect.Effect<unknown> =>
  native(() => response.json());

const userStoreBytes = Effect.fn(function* (runtime: Miniflare, userId: string) {
  const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

  const response = yield* native(() =>
    users.getByName(userId).fetch("https://fixture.invalid/database-size")
  );

  expect(response.status).toBe(200);

  return yield* Schema.decodeUnknownEffect(Schema.Int)(yield* native(() => response.json()));
});

const capturePayload = {
  money: { amount: "31.77", currency: "USD" },
  direction: "outflow",
  occurredAt: "2023-11-16T00:00:00.000Z",
};

const patCapture = (
  runtime: Miniflare,
  bearer: string,
  call: string | Readonly<{ key: string; payload: typeof capturePayload }>
): ReturnType<typeof history> =>
  native(() =>
    nativeIngress(runtime)(`https://${productionTopology.ingress.hostname}/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + bearer,
        "Fidy-Retry-Key": typeof call === "string" ? call : call.key,
        "CF-Connecting-IP": "192.0.2.1",
      },
      body: JSON.stringify(typeof call === "string" ? capturePayload : call.payload),
    })
  );

const provisionPAT = Effect.fn(function* (
  owner: Effect.Success<ReturnType<typeof seed>>,
  subject: typeof alice,
  { id, shortId }: Readonly<{ id: string; shortId: string }>
) {
  const bearer = "fin_" + shortId + "_" + "x".repeat(43);

  const digest = yield* native(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
  );

  yield* owner.exec(
    "INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES (?,?,?,?,'agent',?,7,?,?,?,?)",
    id,
    subject.user,
    shortId,
    digest,
    '["write"]',
    owner.now,
    owner.now,
    owner.now + 604800000,
    id
  );
  yield* native(() =>
    owner.directory.exec(
      "INSERT INTO pat_routes VALUES (?,?,?,?,?)",
      shortId,
      subject.user,
      id,
      id,
      owner.now + 604800000
    )
  );

  return bearer;
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("requires an observable lifetime registration before first local work", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform;
      const runtime = yield* create();
      const owner = yield* seed(runtime, alice);
      yield* owner.exec(
        "CREATE TRIGGER lose_ack BEFORE UPDATE OF lifetime_registered ON users BEGIN SELECT RAISE(ABORT,'lost'); END"
      );
      expect(yield* receivedStatus(history(runtime))).toBe(503);
      expect(yield* owner.exec("SELECT count(*) AS calls FROM audit_entries")).toEqual([
        { calls: 0 },
      ]);

      const registry = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Maintenance", {
          name: "core-maintenance-v1",
        })
      );

      const entries = native(() =>
        registry.exec("SELECT user_id FROM lifetime_registry ORDER BY user_id")
      );

      expect(yield* entries).toEqual([{ user_id: alice.user }]);
      yield* owner.exec("DROP TRIGGER lose_ack");
      expect(yield* receivedStatus(history(runtime))).toBe(200);
      const waiting = yield* seed(runtime, bob);
      yield* native(() => registry.exec("ALTER TABLE lifetime_registry RENAME TO offline"));
      expect(yield* receivedStatus(history(runtime))).toBe(200);
      expect(yield* receivedStatus(history(runtime, bob))).toBe(503);
      expect(yield* waiting.exec("SELECT count(*) AS calls FROM audit_entries")).toEqual([
        { calls: 0 },
      ]);
      yield* native(() => registry.exec("ALTER TABLE offline RENAME TO lifetime_registry"));
      expect(yield* receivedStatus(history(runtime, bob))).toBe(200);
      expect(yield* entries).toEqual([{ user_id: alice.user }, { user_id: bob.user }]);
    })
  );

  test.effect(
    "rolls back a refused link commit, then replays completed changes under the same PAT without charging twice",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);

        const token = yield* provisionPAT(owner, alice, {
          id: "10000000-0000-4000-8000-000000000091",
          shortId: "abcd1234",
        });

        yield* owner.exec(
          "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) SELECT ?,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms+1 FROM transactions WHERE id=?",
          second,
          transaction
        );
        const pair = { firstTransactionId: transaction, secondTransactionId: second };

        const send = (path: string, key: string, body: unknown): ReturnType<typeof history> =>
          native(() =>
            nativeIngress(runtime)(
              `https://${productionTopology.ingress.hostname}/transactions/${path}`,
              {
                method: path === transaction ? "PUT" : "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: "Bearer " + token,
                  "CF-Connecting-IP": "192.0.2.1",
                  "Fidy-Retry-Key": key,
                },
                body: JSON.stringify(body),
              }
            )
          );

        yield* owner.exec(
          "CREATE TRIGGER fail_link BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' BEGIN SELECT RAISE(IGNORE); END"
        );
        expect((yield* send("link", "lost-link", pair)).status).toBe(503);
        expect(
          yield* owner.exec(
            "SELECT (SELECT count(*) FROM transaction_reconciliation_decisions) AS decisions,(SELECT count(*) FROM audit_entries) AS audits,(SELECT count(*) FROM canonical_request_receipts) AS receipts,(SELECT count(*) FROM commercial_allowance_consumptions) AS charges"
          )
        ).toEqual([{ decisions: 0, audits: 0, receipts: 0, charges: 0 }]);
        yield* owner.exec("DROP TRIGGER fail_link");
        const linked = yield* send("link", "lost-link", pair);
        expect(linked.status).toBe(200);
        const committed = yield* jsonBody(linked);

        const correction = {
          expectedRevision: 0,
          changes: { money: { amount: "9999999999999999.13", currency: "COP" }, notes: "exact" },
        };

        const concurrent = yield* Effect.all(
          [
            send(transaction, "lost-correction", correction),
            send(transaction, "lost-correction", correction),
          ],
          { concurrency: 2 }
        );

        expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
        expect(yield* jsonBody(concurrent[0])).toEqual(yield* jsonBody(concurrent[1]));
        const restored = yield* send("unlink", "lost-unlink", pair);
        expect(restored.status).toBe(200);
        expect(yield* jsonBody(yield* send("link", "lost-link", pair))).toEqual(committed);
        expect(yield* jsonBody(yield* send("unlink", "lost-unlink", pair))).toEqual(
          yield* jsonBody(restored)
        );
        expect(yield* jsonBody(yield* history(runtime))).toMatchObject({
          data: [
            { id: second, money: { amount: "9007199254740993.15", currency: "USD" } },
            { id: transaction, revision: 1, money: correction.changes.money },
          ],
        });
        expect(
          yield* owner.exec(
            "SELECT (SELECT count(*) FROM transaction_corrections) AS corrections,(SELECT count(*) FROM canonical_request_receipts) AS receipts,(SELECT count(*) FROM commercial_allowance_consumptions) AS charges"
          )
        ).toEqual([{ corrections: 1, receipts: 3, charges: 3 }]);
      })
  );
  test.effect("corrects, links, inspects and unlinks retained User transactions", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform;
      const runtime = yield* create();
      const owner = yield* seed(runtime, alice);
      yield* seed(runtime, bob);

      const call = (path: string, method: string, body?: unknown): ReturnType<typeof history> =>
        native(() =>
          nativeIngress(runtime)(
            `https://${productionTopology.ingress.hostname}/transactions/${path}`,
            {
              method,
              headers: {
                origin: browserOrigins.production,
                "Fidy-Session-Binding": alice.session,
                cookie: `__Host-fidy_session=${alice.bearer}`,
                "content-type": "application/json",
              },
              ...Option.match(Option.fromUndefinedOr(body), {
                onNone: () => ({}),
                onSome: (body) => ({ body: JSON.stringify(body) }),
              }),
            }
          )
        );

      const money = { amount: "9007199254740993.15", currency: "USD" };
      const correction = { expectedRevision: 0, changes: { counterparty: "corrected" } };
      const corrected = yield* call(transaction, "PUT", correction);
      expect(corrected.status).toBe(200);
      expect(yield* jsonBody(corrected)).toMatchObject({
        data: { revision: 1, money, counterparty: "corrected" },
      });
      expect((yield* call(transaction, "PUT", correction)).status).toBe(400);
      yield* owner.exec(
        "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'9007199254740993.15','USD','outflow',?,?,?)",
        second,
        alice.user,
        category,
        instant + 1000,
        instant + 1000
      );
      yield* owner.exec(
        "INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms) VALUES ('evidence',?,?,'statement-line','CO','es-CO','America/Bogota','statement-v1',?)",
        alice.user,
        second,
        instant
      );
      const pair = { firstTransactionId: second, secondTransactionId: transaction };
      expect(
        (yield* native(() =>
          nativeIngress(runtime)(
            `https://${productionTopology.ingress.hostname}/transactions/link`,
            {
              method: "POST",
              headers: {
                origin: browserOrigins.production,
                "Fidy-Session-Binding": bob.session,
                cookie: `__Host-fidy_session=${bob.bearer}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(pair),
            }
          )
        )).status
      ).toBe(404);
      const linked = yield* call("link", "POST", pair);
      expect(linked.status).toBe(200);
      expect(yield* jsonBody(linked)).toMatchObject({
        data: { id: transaction, money, presentation: { kind: "visible-member" } },
      });
      expect(yield* jsonBody(yield* history(runtime))).toMatchObject({
        data: [{ id: transaction, counterparty: "corrected", money }],
      });
      expect(yield* jsonBody(yield* call(second, "GET"))).toMatchObject({
        data: {
          id: transaction,
          presentation: { kind: "suppressed-member", requestedId: second },
          reconciliation: {
            kind: "linked",
            firstTransaction: { id: transaction },
            secondTransaction: { id: second },
          },
        },
      });
      expect((yield* call("unlink", "POST", pair)).status).toBe(200);
      expect(yield* jsonBody(yield* history(runtime))).toMatchObject({
        data: [
          { id: second, money },
          { id: transaction, money },
        ],
      });
      expect(yield* owner.exec("SELECT fact_revision FROM transaction_projection_state")).toEqual([
        { fact_revision: 6 },
      ]);
      expect(
        yield* owner.exec("SELECT id,kind,interpretation_revision FROM source_attestations")
      ).toEqual([
        { id: "evidence", kind: "statement-line", interpretation_revision: "statement-v1" },
      ]);
    })
  );
  test.effect(
    "serializes overlapping exact retries to a single retained capture, source and charge",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);

        const bearer = yield* provisionPAT(owner, alice, {
          id: "20000000-0000-4000-8000-000000000001",
          shortId: "abcdefgh",
        });

        const [first, second] = yield* Effect.all(
          [patCapture(runtime, bearer, "overlap"), patCapture(runtime, bearer, "overlap")],
          { concurrency: 2 }
        );

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(yield* native(() => first.text())).toBe(yield* native(() => second.text()));
        expect(
          yield* owner.exec(
            "SELECT (SELECT count(*) FROM source_attestations) AS sources,(SELECT sum(units) FROM commercial_allowance_consumptions) AS spent,(SELECT count(*) FROM canonical_request_receipts) AS completed"
          )
        ).toEqual([{ sources: 1, spent: 1, completed: 1 }]);
      })
  );
  test.effect(
    "recovers an existing receipt under capacity pressure, while new growth rolls back its admission",
    () =>
      Effect.gen(function* () {
        const ceiling = 4 * 1024 * 1024;
        const create = yield* nativeCapacityPlatform;
        const runtime = yield* create(String(ceiling));
        const owner = yield* seed(runtime, alice);

        const bearer = yield* provisionPAT(owner, alice, {
          id: "20000000-0000-4000-8000-000000000001",
          shortId: "abcdefgh",
        });

        const initialBytes = yield* userStoreBytes(runtime, alice.user);
        expect(initialBytes).toBeLessThan(ceiling * 0.7);
        expect((yield* patCapture(runtime, bearer, "existing")).status).toBe(201);
        yield* owner.exec("CREATE TABLE storage_pressure (padding BLOB)");
        const healthyBytes = yield* userStoreBytes(runtime, alice.user);
        expect(healthyBytes).toBeLessThan(ceiling * 0.7);
        const target = Math.ceil(ceiling * 0.85);
        const chunk = 256 * 1024;

        const pressure = target - healthyBytes;

        yield* Effect.forEach(
          Array.from({ length: Math.max(0, Math.ceil(pressure / chunk)) }, (_, index) =>
            Math.min(chunk, pressure - index * chunk)
          ),
          (size) => owner.exec("INSERT INTO storage_pressure VALUES(zeroblob(?))", size),
          { discard: true }
        );

        const pressureBytes = yield* userStoreBytes(runtime, alice.user);
        expect(pressureBytes).toBeGreaterThanOrEqual(ceiling * 0.8);
        expect(pressureBytes).toBeLessThan(ceiling);

        const measured = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          initialBytes,
          healthyBytes,
          pressureBytes,
          ceilingBytes: ceiling,
        });

        process.stdout.write(`TRANSACTION_CAPACITY ${measured}\n`);
        expect((yield* patCapture(runtime, bearer, "existing")).status).toBe(201);
        expect((yield* patCapture(runtime, bearer, "new")).status).toBe(503);
        expect(
          yield* owner.exec("SELECT count(*) AS charged FROM commercial_allowance_consumptions")
        ).toEqual([{ charged: 1 }]);
        expect(
          yield* owner.exec("SELECT count(*) AS receipts FROM canonical_request_receipts")
        ).toEqual([{ receipts: 1 }]);
      })
  );
  test.effect(
    "preserves browser credential precedence and throttles unresolved opaque proofs",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);

        const bearer = yield* provisionPAT(owner, alice, {
          id: "20000000-0000-4000-8000-000000000001",
          shortId: "abcdefgh",
        });

        const mixed = (binding: string): ReturnType<typeof history> =>
          native(() =>
            nativeIngress(runtime)(`https://${productionTopology.ingress.hostname}/transactions`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer " + bearer,
                origin: browserOrigins.production,
                "Fidy-Session-Binding": binding,
                cookie: `__Host-fidy_session=${alice.bearer}`,
                "CF-Connecting-IP": "192.0.2.1",
              },
              body: JSON.stringify(capturePayload),
            })
          );

        expect(yield* receivedStatus(mixed(bob.session))).toBe(401);
        expect(yield* receivedStatus(mixed(alice.session))).toBe(201);
        expect(yield* receivedStatus(patCapture(runtime, "invalid", "key"))).toBe(401);
        yield* native(() =>
          owner.directory.exec(
            "UPDATE unresolved_source_buckets SET virtual_at_ms=?",
            owner.now + 600000
          )
        );
        expect(yield* receivedStatus(patCapture(runtime, "invalid", "key"))).toBe(429);
        expect(
          yield* owner.exec("SELECT count(*) AS calls FROM commercial_allowance_consumptions")
        ).toEqual([{ calls: 0 }]);
        expect(
          yield* owner.exec(
            "SELECT count(*) AS calls FROM audit_entries WHERE record_type='session_call'"
          )
        ).toEqual([{ calls: 1 }]);
      })
  );
  test.effect(
    "keeps an accountable read available under User storage pressure and isolates an uncommittable Audit",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create("500000");
        const pressured = yield* seed(runtime, alice);
        const independent = yield* seed(runtime, bob);
        yield* pressured.exec(
          `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<180)
      INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms,notes)
      SELECT printf('31000000-0000-4000-8000-%012d',i),?,'500','COP','outflow',?,i,i,printf('%0500d',i) FROM n`,
          alice.user,
          category
        );
        expect((yield* history(runtime, alice, "?limit=1")).status).toBe(200);
        expect(yield* pressured.exec("SELECT count(*) AS total FROM audit_entries")).toEqual([
          { total: 1 },
        ]);
        yield* pressured.exec(
          "CREATE TRIGGER full_audit BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT,'capacity'); END"
        );
        expect((yield* history(runtime, alice, "?limit=1")).status).toBe(503);
        expect(yield* pressured.exec("SELECT count(*) AS total FROM audit_entries")).toEqual([
          { total: 1 },
        ]);
        expect((yield* history(runtime, bob, "?limit=1")).status).toBe(200);
        expect(yield* independent.exec("SELECT count(*) AS total FROM audit_entries")).toEqual([
          { total: 1 },
        ]);
      })
  );
  test.effect(
    "retains metadata alone for one-time operations, and a completion never authorizes disclosure",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);
        const pat = "20000000-0000-4000-8000-000000000001";
        const bearer = yield* provisionPAT(owner, alice, { id: pat, shortId: "abcdefgh" });
        expect((yield* patCapture(runtime, bearer, "safe-result")).status).toBe(201);

        const storage = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: alice.user })
        );

        const secretBody = '{"bearer":"one-time-fixture"}';

        const invalid = yield* Effect.result(
          Effect.tryPromise(() =>
            storage.exec(
              "UPDATE canonical_request_receipts SET operation='pats.createManualPAT',body=?",
              secretBody
            )
          )
        );

        expect(invalid._tag).toBe("Failure");
        yield* owner.exec(
          "UPDATE canonical_request_receipts SET operation='pats.createManualPAT',body=NULL"
        );
        const mismatch = yield* patCapture(runtime, bearer, "safe-result");
        expect(mismatch.status).toBe(400);
        expect(yield* native(() => mismatch.text())).not.toContain("one-time-fixture");
        yield* owner.exec(
          "UPDATE canonical_request_receipts SET operation='transactions.createTransaction',body=NULL"
        );
        const unavailable = yield* patCapture(runtime, bearer, "safe-result");
        expect(unavailable.status).toBe(400);
        expect(yield* native(() => unavailable.text())).toContain("cannot replay");
        expect(yield* owner.exec("SELECT count(*) AS effects FROM source_attestations")).toEqual([
          { effects: 1 },
        ]);
        expect(
          yield* owner.exec("SELECT sum(units) AS spent FROM commercial_allowance_consumptions")
        ).toEqual([{ spent: 1 }]);
      })
  );
  test.effect(
    "rejects invalid input before charging, checks live Free exhaustion and records zero-unit Pro work",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);

        const bearer = yield* provisionPAT(owner, alice, {
          id: "20000000-0000-4000-8000-000000000001",
          shortId: "abcdefgh",
        });

        expect((yield* patCapture(runtime, bearer, "bad key")).status).toBe(400);
        expect(
          (yield* patCapture(runtime, bearer, {
            key: "bad-input",
            payload: {
              ...capturePayload,
              money: { amount: "invalid", currency: "USD" },
            },
          })).status
        ).toBe(400);
        expect(
          yield* owner.exec("SELECT count(*) AS spent FROM commercial_allowance_consumptions")
        ).toEqual([{ spent: 0 }]);
        expect((yield* patCapture(runtime, bearer, "first")).status).toBe(201);
        yield* owner.exec(
          "WITH RECURSIVE n(v) AS(VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<49) INSERT INTO commercial_allowance_consumptions SELECT c.user_id,c.allowance,'used-'||n.v,c.period_start_ms,c.accepted_at_ms,1 FROM commercial_allowance_consumptions c CROSS JOIN n WHERE c.allowance='canonical_call'"
        );
        const exhausted = yield* patCapture(runtime, bearer, "after-limit");
        expect(exhausted.status).toBe(429);
        expect(yield* native(() => exhausted.text())).toContain("quota_exhausted");
        const retry = yield* patCapture(runtime, bearer, "first");
        expect(retry.status).toBe(201);
        expect(retry.headers.get("fidy-canonical-remaining")).toBe("0");
        yield* owner.exec(
          "UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?",
          owner.now,
          owner.now + 604800000,
          alice.user
        );
        const pro = yield* patCapture(runtime, bearer, "after-limit");
        expect(pro.status).toBe(201);
        expect(pro.headers.get("fidy-canonical-remaining")).toBe("uncapped");
        expect(
          yield* owner.exec(
            "SELECT count(*) AS zero FROM commercial_allowance_consumptions WHERE units=0"
          )
        ).toEqual([{ zero: 1 }]);
      })
  );
  test.effect(
    "rolls back capture, source, projection, accounting and Audit when completion fails before commit",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);

        const bearer = yield* provisionPAT(owner, alice, {
          id: "20000000-0000-4000-8000-000000000001",
          shortId: "abcdefgh",
        });

        yield* Effect.forEach(
          ["source_attestations", "audit_entries", "canonical_request_receipts"],
          Effect.fnUntraced(function* (table) {
            yield* owner.exec(
              `CREATE TRIGGER fail_capture BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`
            );
            const interrupted = yield* patCapture(runtime, bearer, "before-commit");
            expect(interrupted.status).toBe(503);
            expect(interrupted.headers.get("fidy-canonical-remaining")).toBeNull();
            expect(
              yield* owner.exec(
                "SELECT (SELECT count(*) FROM transactions) AS movements,(SELECT count(*) FROM transaction_projection_leaf) AS projected,(SELECT count(*) FROM source_attestations) AS sources,(SELECT count(*) FROM commercial_allowance_consumptions) AS spent,(SELECT count(*) FROM audit_entries) AS audited,(SELECT count(*) FROM canonical_request_receipts) AS completed,(SELECT last_used_at_ms FROM pats) AS used"
              )
            ).toEqual([
              {
                movements: 1,
                projected: 1,
                sources: 0,
                spent: 0,
                audited: 0,
                completed: 0,
                used: null,
              },
            ]);
            yield* owner.exec("DROP TRIGGER fail_capture");
          }),
          { discard: true }
        );

        expect((yield* patCapture(runtime, bearer, "before-commit")).status).toBe(201);
        expect(
          yield* owner.exec("SELECT count(*) AS projected FROM transaction_projection_leaf")
        ).toEqual([{ projected: 2 }]);
      })
  );
  test.effect(
    "charges admitted refusals once, revalidates capability and Consent, and replaces only an expired receipt",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);
        const pat = "20000000-0000-4000-8000-000000000001";
        const bearer = yield* provisionPAT(owner, alice, { id: pat, shortId: "abcdefgh" });

        const other = yield* provisionPAT(owner, alice, {
          id: "20000000-0000-4000-8000-000000000002",
          shortId: "ijklmno1",
        });

        const future = { ...capturePayload, occurredAt: "2099-12-31T00:00:00.000Z" };
        const key = "admitted-refusal";
        const refusal = yield* patCapture(runtime, bearer, { key, payload: future });
        expect(refusal.status).toBe(400);
        const body = yield* native(() => refusal.text());
        expect(body).toContain("cannot occur in the future");
        const recovered = yield* patCapture(runtime, other, { key, payload: future });
        expect(yield* native(() => recovered.text())).toBe(body);
        const changed = yield* patCapture(runtime, other, key);
        expect(changed.status).toBe(400);
        expect(yield* native(() => changed.text())).toContain("already bound");
        expect(
          yield* owner.exec("SELECT sum(units) AS spent FROM commercial_allowance_consumptions")
        ).toEqual([{ spent: 1 }]);
        yield* owner.exec("UPDATE pats SET scopes_json=? WHERE id=?", '["read"]', pat);
        const denied = yield* patCapture(runtime, bearer, { key, payload: future });
        expect(denied.status).toBe(403);
        expect(yield* native(() => denied.text())).toContain("scope_missing");
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('withdrawn',?,'processing_withdrawal',?)",
          alice.user,
          owner.now
        );
        const withdrawn = yield* patCapture(runtime, other, { key, payload: future });
        expect(withdrawn.status).toBe(403);
        expect(yield* native(() => withdrawn.text())).toContain("user_action_required");
        expect(withdrawn.headers.get("fidy-canonical-remaining")).toBeNull();
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,withdrawal_id,record_type,occurred_at_ms) VALUES('renewed',?,'withdrawn','processing_renewal',?)",
          alice.user,
          owner.now
        );
        yield* owner.exec(
          "UPDATE canonical_request_receipts SET accepted_at_ms=accepted_at_ms-86400000"
        );
        const fresh = yield* patCapture(runtime, other, key);
        expect(fresh.status).toBe(201);
        expect(
          yield* owner.exec("SELECT sum(units) AS spent FROM commercial_allowance_consumptions")
        ).toEqual([{ spent: 2 }]);
        expect(
          yield* owner.exec("SELECT count(*) AS receipts FROM canonical_request_receipts")
        ).toEqual([{ receipts: 1 }]);
      })
  );
  test.effect(
    "rejects stale PAT routes and foreign credentials, and isolates identical retry keys across Users",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const first = yield* seed(runtime, alice);
        const second = yield* seed(runtime, bob);

        const patId = "20000000-0000-4000-8000-000000000001",
          otherId = "20000000-0000-4000-8000-000000000002";

        const credential = yield* provisionPAT(first, alice, { id: patId, shortId: "abcdefgh" });
        const foreign = yield* provisionPAT(second, bob, { id: otherId, shortId: "bcdefghi" });
        const key = "shared-key";
        const original = yield* patCapture(runtime, credential, key);
        const separate = yield* patCapture(runtime, foreign, key);
        expect(original.status).toBe(201);
        expect(separate.status).toBe(201);
        expect(yield* native(() => separate.text())).not.toBe(yield* native(() => original.text()));
        yield* native(() =>
          first.directory.exec(
            "UPDATE pat_routes SET user_id=?,pat_id=? WHERE short_id=?",
            bob.user,
            otherId,
            "abcdefgh"
          )
        );
        const stale = yield* patCapture(runtime, credential, key);
        expect(stale.status).toBe(401);
        expect(stale.headers.get("fidy-canonical-remaining")).toBeNull();
        const bad = yield* patCapture(runtime, foreign.slice(0, -1) + "z", key);
        expect(bad.status).toBe(401);

        yield* Effect.forEach(
          [first, second],
          Effect.fnUntraced(function* (owner) {
            expect(
              yield* owner.exec("SELECT count(*) AS charged FROM commercial_allowance_consumptions")
            ).toEqual([{ charged: 1 }]);
            expect(
              yield* owner.exec("SELECT count(*) AS receipts FROM canonical_request_receipts")
            ).toEqual([{ receipts: 1 }]);
          }),
          { discard: true }
        );
      })
  );
  test.effect(
    "retries a lost PAT capture response exactly once across shutdown under current local authority",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const pat = "20000000-0000-4000-8000-000000000001";
        const key = "capture-lost";

        const retained = yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* create();
            const owner = yield* seed(runtime, alice);
            const bearer = yield* provisionPAT(owner, alice, { id: pat, shortId: "abcdefgh" });
            const capture = yield* patCapture(runtime, bearer, key);
            expect(capture.status).toBe(201);
            const standing = capture.headers.get("fidy-canonical-remaining");

            const receipt = yield* owner.exec(
              "SELECT body,accepted_at_ms FROM canonical_request_receipts"
            );

            expect(receipt).toHaveLength(1);

            return { bearer, standing, receipt };
          })
        );

        const runtime = yield* create();
        const replay = yield* patCapture(runtime, retained.bearer, key);
        expect(replay.status).toBe(201);
        expect(replay.headers.get("fidy-canonical-remaining")).toBe(retained.standing);
        expect(yield* native(() => replay.text())).toBe(retained.receipt[0]?.body);

        const local = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: alice.user })
        );

        expect(
          yield* native(() =>
            local.exec("SELECT body,accepted_at_ms FROM canonical_request_receipts")
          )
        ).toEqual(retained.receipt);
        expect(
          yield* native(() => local.exec("SELECT count(*) AS movements FROM source_attestations"))
        ).toEqual([{ movements: 1 }]);
        expect(
          yield* native(() =>
            local.exec("SELECT sum(units) AS spent FROM commercial_allowance_consumptions")
          )
        ).toEqual([{ spent: 1 }]);
        expect(
          yield* native(() =>
            local.exec(
              "SELECT count(*) AS calls FROM audit_entries WHERE record_type='credential_call' AND outcome='accepted'"
            )
          )
        ).toEqual([{ calls: 2 }]);
        yield* native(() =>
          local.exec("UPDATE pats SET revoked_at_ms=created_at_ms WHERE id=?", pat)
        );
        expect((yield* patCapture(runtime, retained.bearer, key)).status).toBe(401);
      })
  );
  test.effect(
    "publishes a browser capture and its manual source atomically in the fresh User history",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const { exec } = yield* seed(runtime, alice);

        const capture = yield* native(() =>
          nativeIngress(runtime)(`https://${productionTopology.ingress.hostname}/transactions`, {
            method: "POST",
            headers: {
              origin: browserOrigins.production,
              "Fidy-Session-Binding": alice.session,
              cookie: `__Host-fidy_session=${alice.bearer}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              money: { amount: "31.77", currency: "USD" },
              direction: "outflow",
              occurredAt: "2023-11-16T00:00:00.000Z",
            }),
          })
        );

        expect(capture.status).toBe(201);
        const body = yield* native(() => capture.json());
        expect(body).toMatchObject({
          data: { money: { amount: "31.77", currency: "USD" } },
          next: [],
        });
        const page = yield* history(runtime);
        expect(yield* native(() => page.json())).toMatchObject({
          data: [{ money: { amount: "31.77", currency: "USD" } }, { id: transaction }],
        });
        expect(yield* exec("SELECT kind,interpretation_revision FROM source_attestations")).toEqual(
          [{ kind: "manual", interpretation_revision: "manual-v1" }]
        );
        expect(
          yield* exec("SELECT count(*) AS spent FROM commercial_allowance_consumptions")
        ).toEqual([{ spent: 0 }]);
      })
  );
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

        yield* Effect.forEach(
          [aliceStore, bobStore],
          Effect.fnUntraced(function* (owner) {
            expect(yield* owner.exec("SELECT COUNT(*) AS count FROM audit_entries")).toEqual([
              { count: 0 },
            ]);
            expect(
              yield* owner.exec("SELECT COUNT(*) AS count FROM canonical_request_buckets")
            ).toEqual([{ count: 0 }]);
          }),
          { discard: true }
        );
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

  const projectionReadiness = ["ready", "rebuilding", "absent"];

  const testProjectionReadiness = (readiness: (typeof projectionReadiness)[number]): void => {
    test.effect(`reads complete effective facts with a ${readiness} projection`, () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const { exec, now } = yield* seed(runtime, alice);
        yield* exec(
          "INSERT INTO transaction_corrections(id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at_ms) VALUES ('fixture',?,?,0,'[]','{}','{}',?)",
          alice.user,
          transaction,
          now
        );
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
        yield* exec("DELETE FROM transaction_projection_leaf WHERE user_id=?", alice.user);
        yield* exec(
          "INSERT INTO transaction_projection_leaf(user_id,id,amount,currency,direction,category_id,counterparty,notes,occurred_at_ms,created_at_ms,revision) SELECT user_id,id,amount,currency,direction,category_id,counterparty,notes,occurred_at_ms,created_at_ms,revision FROM transaction_effective_source"
        );

        if (readiness === "absent") {
          yield* exec("DELETE FROM transaction_projection_state WHERE user_id=?", alice.user);
        } else {
          yield* exec(
            "UPDATE transaction_projection_state SET readiness=? WHERE user_id=?",
            readiness,
            alice.user
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

        yield* Effect.gen(function* () {
          yield* exec("UPDATE transaction_projection_leaf SET amount='invalid-money'");
          const malformed = yield* history(runtime);
          expect(malformed.status).toBe(503);
          expect(yield* exec("SELECT count(*) AS total FROM audit_entries")).toEqual([
            { total: 3 },
          ]);
        }).pipe(Effect.when(Effect.succeed(readiness === "ready")));
      })
    );
  };

  projectionReadiness.forEach(testProjectionReadiness);
});
