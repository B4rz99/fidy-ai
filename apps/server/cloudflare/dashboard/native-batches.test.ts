import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  alice,
  bob,
  category,
  makeNativeTransactionJourney,
  nativeBrowserWrite,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";
import { webSignupDisclosure } from "../../src/shell/consent/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { canonicalRequestProtection } from "../canonical-admission/contract";

const init = "dashboard.initializeDashboard",
  edit = "dashboard.applyDashboardEdit";

const objectSnapshot = "SELECT kind,revision,document_json FROM user_documents ORDER BY kind";

type BatchChild = Readonly<{ callId: string; operation: string; input: Schema.Json }>;

type TitleEdit = Readonly<{ op: "set-title"; title: string }>;

const child = (operation: string, input: Schema.Json = {}, index = 1): BatchChild => ({
  callId: "22570000-0000-4000-8000-" + String(index).padStart(12, "0"),
  operation,
  input,
});

const title = (name: string): TitleEdit => ({ op: "set-title", title: name });

const setup = Effect.fn(function* () {
  const db = yield* makeNativeTransactionJourney(undefined, nativeBillingPlatform);
  const individual = nativeBrowserWrite(db);

  const post = Effect.fn(function* (who: typeof alice, path: string, body: Schema.Json) {
    yield* Effect.sleep(canonicalRequestProtection.intervalMs);

    return yield* individual(who, { method: "POST", path, body });
  });

  const batch = Effect.fn(function* (who: typeof alice, ...calls: ReadonlyArray<BatchChild>) {
    return yield* post(who, "/operations/atomic-batch", { calls });
  });

  const proof = Effect.fn(function* (scope: string, id: string) {
    const token = "fin_" + id.repeat(8) + "_" + "c".repeat(43);
    yield* seedNativePAT({
      db,
      userId: alice.user,
      token,
      scopes: [scope],
      current: yield* Clock.currentTimeMillis,
    });

    return Effect.fn(function* (path: string, body: Schema.Json) {
      yield* Effect.sleep(canonicalRequestProtection.intervalMs);

      return yield* native(() =>
        db.send(
          new Request("https://api.fidyapp.com" + path, {
            method: "POST",
            headers: { authorization: "Bearer " + token, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        )
      );
    });
  });

  const exec = Effect.fn(function* (
    user: typeof alice,
    sql: string,
    ...params: Array<string | number>
  ) {
    return yield* native(() => db.owner(user.user).exec(sql, ...params));
  });

  return { db, post, batch, proof, exec };
});

type Harness = Effect.Success<ReturnType<typeof setup>>;

type ScopedBatch = Effect.Success<ReturnType<Harness["proof"]>>;

const browserRead = Effect.fn(function* (db: Harness["db"], path: string) {
  expect((yield* native(() => db.browser(0, path))).status, path).toBe(200);
});

const refusedDashboardChange = Effect.fn(function* (
  { batch, exec }: Harness,
  [change, code]: readonly [Schema.Json, string]
) {
  const refused = yield* batch(alice, child(init), child(edit, { payload: change }, 2));
  expect(refused.status).toBe(400);
  expect(yield* native(() => refused.json())).toMatchObject({
    error: { code, failedCallIndex: 1, operation: edit },
  });
  expect(yield* exec(alice, objectSnapshot)).toEqual([]);
});

const deniedScopeBatch = Effect.fn(function* (
  exec: Harness["exec"],
  [call, calls]: readonly [ScopedBatch, ReadonlyArray<BatchChild>]
) {
  const denied = yield* call("/operations/atomic-batch", { calls });
  expect(denied.status).toBe(403);
  expect(yield* native(() => denied.json())).toMatchObject({
    error: { code: "scope_missing" },
  });
  expect(yield* exec(alice, objectSnapshot)).toEqual([]);
  expect(yield* exec(alice, "SELECT count(*) n FROM transactions")).toEqual([{ n: 0 }]);
});

const userActionRequired = Effect.fn(function* (result: Response) {
  expect(result.status).toBe(403);
  expect(yield* native(() => result.json())).toMatchObject({
    error: { code: "user_action_required" },
  });
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "publishes one first edit, returns retained revisions through single and batch initialization and keeps both Users' documents independent",
    () =>
      Effect.gen(function* () {
        const { db, post, batch, exec } = yield* setup();
        expect(
          (yield* post(alice, "/recurring-plans/edits", {
            expectedRevision: 0,
            edit: {
              kind: "create",
              id: "40000000-0000-4000-8000-000000000123",
              plan: {
                name: "Arriendo",
                kind: "expense",
                currency: "COP",
                amountMode: "fixed",
                money: { amount: "1000000", currency: "COP" },
                firstDate: "2026-10-31",
                timeZone: "America/Bogota",
                frequency: "monthly",
              },
            },
          })).status
        ).toBe(200);
        const planning = yield* exec(alice, objectSnapshot);
        expect(planning).toHaveLength(1);
        expect((yield* post(alice, "/dashboard/edits", title("Privado"))).status).toBe(200);
        const before = yield* exec(alice, objectSnapshot);
        const again = yield* batch(alice, child(init));
        expect(again.status).toBe(200);
        expect(yield* native(() => again.json())).toMatchObject({
          data: { results: [{ output: { data: { title: "Privado" } } }] },
        });
        expect((yield* post(alice, "/dashboard/initialize", {})).status).toBe(200);
        expect(yield* exec(alice, objectSnapshot + " LIMIT 1 OFFSET 1")).toEqual(planning);
        expect(yield* exec(alice, objectSnapshot)).toEqual(before);
        const other = yield* batch(bob, child(edit, { payload: title("Independiente") }));
        expect(other.status).toBe(200);
        expect(yield* native(() => other.json())).toMatchObject({
          data: { results: [{ output: { data: { title: "Independiente" } } }] },
        });

        yield* Effect.forEach(
          ["/dashboard/catalog", "/quota", "/subscription/offers", "/subscription/upgrade-url"],
          (path) => browserRead(db, path),
          { discard: true }
        );

        expect(yield* exec(alice, objectSnapshot)).toEqual(before);

        const wrong = yield* native(() =>
          db.send(
            new Request("https://api.fidyapp.com/operations/atomic-batch", {
              method: "POST",
              headers: {
                origin: "https://app.fidyapp.com",
                "Fidy-Session-Binding": bob.session,
                cookie: "__Host-fidy_session=" + alice.bearer,
                "content-type": "application/json",
              },
              body: JSON.stringify({ calls: [child(init)] }),
            })
          )
        );

        expect(wrong.ok).toBe(false);
        expect(yield* native(() => wrong.text())).not.toContain("Privado");
        expect(yield* exec(alice, objectSnapshot)).toEqual(before);
      })
  );
  test.effect(
    "rolls back the first Dashboard child on a conflicting document, missing Widget or missing mandatory Audit",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup();
        const { post, batch, exec } = harness;

        yield* Effect.forEach(
          [
            [title("colisión"), "validation_failed"],
            [
              { op: "remove-widget", widgetId: "30000000-0000-4000-8000-000000000099" },
              "not_found",
            ],
          ] as const,
          (refusal) => refusedDashboardChange(harness, refusal),
          { discard: true }
        );

        yield* exec(
          alice,
          "CREATE TRIGGER deny_dashboard_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='dashboard.initializeDashboard' BEGIN SELECT RAISE(IGNORE); END"
        );
        expect((yield* post(alice, "/dashboard/initialize", {})).status).toBe(503);
        expect((yield* batch(alice, child(init))).status).toBe(503);
        expect(yield* exec(alice, objectSnapshot)).toEqual([]);
        expect(
          yield* exec(
            alice,
            "SELECT count(*) n FROM audit_entries WHERE operation='dashboard.initializeDashboard' AND outcome='success'"
          )
        ).toEqual([{ n: 0 }]);
      })
  );
  test.effect(
    "attributes Dashboard PAT initialization and rejects read-only or write-only batch children without publishing any sibling",
    () =>
      Effect.gen(function* () {
        const { proof, exec } = yield* setup();

        const read = yield* proof("read", "r"),
          write = yield* proof("write", "w"),
          dashboard = yield* proof("dashboard", "d");

        const first = child(init),
          capture = child(
            "transactions.createTransaction",
            {
              payload: {
                categoryId: category,
                money: { amount: "1", currency: "COP" },
                direction: "outflow",
                occurredAt: "2026-09-06T00:00:00Z",
              },
            },
            2
          );

        yield* Effect.forEach(
          [
            [read, [first]],
            [write, [capture, first]],
            [dashboard, [first, capture]],
          ] as const,
          (denial) => deniedScopeBatch(exec, denial),
          { discard: true }
        );

        expect((yield* dashboard("/dashboard/initialize", {})).status).toBe(200);
        expect((yield* dashboard("/operations/atomic-batch", { calls: [first] })).status).toBe(200);
        expect(
          yield* exec(
            alice,
            "SELECT count(*) n FROM audit_entries a JOIN pats p ON p.id=a.pat_id AND p.user_id=a.user_id WHERE a.operation='dashboard.initializeDashboard' AND outcome='accepted' AND p.short_id='dddddddd'"
          )
        ).toEqual([{ n: 2 }]);
        const original = yield* exec(alice, objectSnapshot);
        expect(
          (yield* read("/operations/atomic-batch", {
            calls: [child(edit, { payload: title("invalid") })],
          })).status
        ).toBe(403);
        expect(yield* exec(alice, objectSnapshot)).toEqual(original);
      })
  );
  test.effect(
    "withdrawn Consent bars Dashboard initialization and batch siblings through both credentials",
    () =>
      Effect.gen(function* () {
        const { proof, post, batch, exec } = yield* setup();
        const dashboard = yield* proof("dashboard", "d");

        const disclosure = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
          webSignupDisclosure()
        );

        yield* exec(
          alice,
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
          "22570000-0000-4000-8000-000000000011",
          alice.user,
          (yield* Clock.currentTimeMillis) - 1000,
          disclosure
        );
        expect((yield* post(alice, "/web/consent/withdraw", { confirm: true })).status).toBe(200);

        const signedOut = [
          yield* post(alice, "/dashboard/initialize", {}),
          yield* batch(alice, child(init)),
        ];

        expect(signedOut.map((result) => result.status)).toEqual([401, 401]);

        const actionRequired = [
          yield* dashboard("/dashboard/initialize", {}),
          yield* dashboard("/operations/atomic-batch", { calls: [child(init)] }),
        ];

        yield* Effect.forEach(actionRequired, (result) => userActionRequired(result), {
          discard: true,
        });

        expect(yield* exec(alice, objectSnapshot)).toEqual([]);
        expect(
          yield* exec(
            alice,
            "SELECT count(*) n FROM audit_entries WHERE operation='dashboard.initializeDashboard' AND outcome IN('accepted','success')"
          )
        ).toEqual([{ n: 0 }]);
      })
  );
  test.effect.each([false, true])(
    "rechecks the PAT at publication and rolls back a raced revocation in a batch=%s",
    (batched) =>
      Effect.gen(function* () {
        const { proof, exec } = yield* setup();
        const dashboard = yield* proof("dashboard", "d");
        yield* exec(
          alice,
          "CREATE TRIGGER revoke_dashboard AFTER INSERT ON audit_entries WHEN NEW.operation='dashboard.initializeDashboard' AND NEW.outcome='accepted' BEGIN UPDATE pats SET revoked_at_ms=NEW.occurred_at_ms WHERE id=NEW.pat_id; END"
        );

        const result = yield* batched
          ? dashboard("/operations/atomic-batch", { calls: [child(init)] })
          : dashboard("/dashboard/initialize", {});

        expect(result.ok).toBe(false);
        expect(yield* exec(alice, objectSnapshot)).toEqual([]);
        expect(
          yield* exec(alice, "SELECT count(*) n FROM audit_entries WHERE outcome='accepted'")
        ).toEqual([{ n: 0 }]);
      })
  );
});
