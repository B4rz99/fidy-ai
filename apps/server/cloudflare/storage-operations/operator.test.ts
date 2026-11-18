import type { Miniflare } from "miniflare";
import { browser } from "../browser-bootstrap.test-fixture";
import { alice, seed } from "../financial-user-store.test-fixture";
import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("inspects Directory schema only with a separately authorized storage operator", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeBrowserPlatform)();
      const path = "https://api.fidyapp.com/internal/storage-operations";
      const { FIXTURE_PROVIDER: signer } = yield* native(() =>
        runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
      );
      for (const issuer of ["support", "reviewer", "storage"]) {
        const signed = yield* native(() =>
          signer.fetch("https://fixture.invalid/" + issuer + "-assertion")
        );
        const token = yield* native(() => signed.text());
        const response = yield* native(() =>
          runtime.dispatchFetch(path, {
            method: "POST",
            headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
            body: JSON.stringify({ action: "inspect", owner: "directory" }),
          })
        );
        expect(response.status).toBe(issuer === "storage" ? 200 : 401);
        if (issuer === "storage") {
          const missing = yield* native(() =>
            runtime.dispatchFetch(path, {
              method: "POST",
              headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
              body: JSON.stringify({
                action: "reconcile-publication",
                owner: "pricing",
                operationId: "10000000-0000-4000-8000-000000000031",
              }),
            })
          );
          expect(missing.status).toBe(404);
          const maintenance = yield* native(() =>
            runtime.dispatchFetch(path, {
              method: "POST",
              headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
              body: JSON.stringify({ action: "inspect", owner: "maintenance" }),
            })
          );
          expect(yield* native(() => maintenance.json())).toMatchObject({
            watchdog: { coverageAgeMs: null, lastAttemptMs: null, lastObservedMs: null },
          });
        }
        if (response.ok) {
          expect(yield* native(() => response.json())).toMatchObject({
            owner: "directory",
            readiness: "ready",
            band: "normal",
          });
        }
      }
    })
  );
});

const session = Effect.fnUntraced(function* (
  start: Effect.Success<typeof nativeBrowserPlatform>,
  deployment: Record<string, string> = {}
) {
  const logs: string[] = [];
  const runtime = yield* start("1000000000", logs, {
    CF_VERSION_METADATA: "22550000-0000-4000-8000-000000000098",
    ...deployment,
  });
  const { FIXTURE_PROVIDER: signer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );
  const signed = yield* native(() => signer.fetch("https://fixture.invalid/storage-assertion"));
  const token = yield* native(() => signed.text());
  const submit = Effect.fnUntraced(function* (
    command: unknown,
    path = "/internal/storage-operations"
  ) {
    return yield* native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com" + path, {
        method: "POST",
        headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
        body: JSON.stringify(command),
      })
    );
  });
  return { runtime, logs, submit };
});
type FixtureStub = ReturnType<
  Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>["getByName"]
>;
const makeFixturePublisher = (
  catalog: FixtureStub,
  now: number
): ((
  publicationId: string,
  priceId: string
) => Effect.Effect<Awaited<ReturnType<FixtureStub["fetch"]>>>) =>
  Effect.fnUntraced(function* (publicationId: string, priceId: string) {
    return yield* native(() =>
      catalog.fetch("https://pricing.internal/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicationId,
          price: {
            id: priceId,
            money: { amount: "11900", currency: "COP" },
            serviceMarket: "CO",
            billingPeriod: "weekly",
            taxTreatment: "not-taxable",
            renewalTerms: {
              automaticRenewal: true,
              renewalReminder: "none",
              cancellation: "future-renewals-only",
              paidAccessEnds: "paid-period-end",
            },
            paymentMethods: ["card", "nequi", "daviplata"],
          },
          authority: {
            permission: "pricing.publish",
            operatorId: "private-publisher",
            expiresAtMs: now + 60000,
          },
        }),
      })
    );
  });

const measureDirectory = Effect.fnUntraced(function* (
  start: Effect.Success<typeof nativeBrowserPlatform>
) {
  const { submit } = yield* session(start);
  const inspect = yield* submit({ action: "inspect", owner: "directory" });
  const reading = yield* Schema.decodeUnknownEffect(Schema.Struct({ bytes: Schema.Int }))(
    yield* native(() => inspect.json())
  );
  return reading.bytes;
});
const storageOperator = Effect.fnUntraced(function* (deployment: Record<string, string> = {}) {
  return yield* session(yield* nativeBrowserPlatform, deployment);
});
const seedStoppedMigration = Effect.fnUntraced(function* (
  start: Effect.Success<typeof nativeBrowserPlatform>
) {
  const { runtime, submit } = yield* session(start);
  const view = yield* submit({ action: "inspect", owner: "directory" });
  const { release, version } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ release: Schema.String, version: Schema.Int })
  )(yield* native(() => view.json()));
  const db = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );
  for (const query of [
    "DROP TRIGGER remove_operator_bootstrap",
    "DROP TRIGGER remove_operator_replacement",
    "DROP TABLE storage_operation_evidence",
  ]) {
    yield* native(() => db.exec(query));
  }
  yield* native(() => db.exec("DELETE FROM store_migrations WHERE version=?", version));
  yield* native(() =>
    db.exec(
      "UPDATE store_migration_attempts SET attempts=3,retry_at_ms=5000,terminal=1 WHERE version=? AND release=?",
      version,
      release
    )
  );
  return { release, version };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "requires a terminal failure coordinate and preserves readiness and the attempt after replay",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeBrowserPlatform;
        const { release, version } = yield* Effect.scoped(seedStoppedMigration(start));
        const { runtime, submit, logs } = yield* session(start);
        const view = yield* submit({ action: "inspect", owner: "directory" });
        expect(yield* native(() => view.json())).toMatchObject({
          version: version - 1,
          readiness: "attempt_refused",
          next: { attempts: 3, terminal: 1 },
        });
        const directory = yield* native(() =>
          runtime.getDurableObjectNamespace("DIRECTORY", "core")
        );
        const check = native(() =>
          directory
            .getByName("directory-v1")
            .fetch("https://owner.internal/work/check", { method: "POST" })
        );
        expect((yield* check).status).toBe(503);
        const retry = {
          action: "retry-migration",
          owner: "directory",
          version,
          attempt: 3,
          release,
          retryAtMs: 5000,
          commandId: "22550000-0000-4000-8000-000000000051",
        };
        expect((yield* submit({ ...retry, retryAtMs: 4999 })).status).toBe(409);
        const exact = { ...retry, commandId: "22550000-0000-4000-8000-000000000052" };
        const applied = yield* submit(exact);
        expect(applied.status).toBe(200);
        expect(yield* native(() => applied.json())).toMatchObject({
          owner: "directory",
          readiness: "ready",
          next: null,
        });
        expect((yield* check).status).toBe(204);
        expect((yield* submit(exact)).status).toBe(409);
        expect(logs.some((line) => line.includes("state=migration-failed severity=critical"))).toBe(
          true
        );
      })
  );
  test.effect(
    "rejects cross-capability assertions and a separately disabled repair grant before work",
    () =>
      Effect.gen(function* () {
        const { submit } = yield* storageOperator({
          STORAGE_REPAIR_ENABLED: "disabled",
          BILLING_SUPPORT_AUDIENCE: "fixture-storage",
          CLOUDFLARE_ACCESS_AUDIENCE: "fixture-storage",
        });
        for (const path of [
          "/internal/support-recovery",
          "/internal/support/billing-refunds",
          "/internal/sample-review",
          "/internal/titular-erasure",
          "/internal/storage-operations",
        ]) {
          expect((yield* submit({ action: "inspect", owner: "directory" }, path)).status).toBe(401);
        }
        const readOnly = yield* storageOperator({ STORAGE_REPAIR_ENABLED: "disabled" });
        expect((yield* readOnly.submit({ action: "inspect", owner: "directory" })).status).toBe(
          200
        );
        expect(
          (yield* readOnly.submit({
            action: "reconcile-reservation",
            owner: "directory",
            family: "bootstrap",
            operationId: "22550000-0000-4000-8000-000000000094",
          })).status
        ).toBe(403);
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "settles only the original expired browser reservation and verifies the destination cancellation",
    () =>
      Effect.gen(function* () {
        const { submit, runtime } = yield* storageOperator();
        const { verified, post } = browser(runtime);
        const { proof, attempt } = yield* verified("storage-reservation");
        const db = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );
        yield* native(() =>
          db.exec(
            "CREATE TRIGGER stop_signup BEFORE INSERT ON recovery_routes BEGIN SELECT RAISE(ABORT,'fixture_interruption'); END"
          )
        );
        const interrupted = yield* post("/web/providers/google/complete", proof);
        expect(interrupted.status).toBe(503);
        const cmd = { owner: "directory", family: "bootstrap", operationId: proof.pairingId };
        expect((yield* submit({ ...cmd, action: "reconcile-reservation" })).status).toBe(409);
        yield* native(() =>
          db.exec("UPDATE provider_attempts SET expires_at_ms=100 WHERE id=?", attempt)
        );
        const settled = yield* submit({ ...cmd, action: "reconcile-reservation" });
        expect(settled.status).toBe(200);
        expect(yield* native(() => settled.json())).toEqual({ outcome: "cancelled" });
        const receipt = yield* submit({ ...cmd, action: "inspect-reservation" });
        expect(yield* native(() => receipt.json())).toEqual({
          outcome: "cancelled",
          deadlineMs: 100,
        });
        expect((yield* post("/web/providers/google/complete", proof)).ok).toBe(false);
      })
  );
  test.effect(
    "observes an exact cancelled replacement at both owners and keeps the prior identity",
    () =>
      Effect.gen(function* () {
        const { runtime, submit } = yield* storageOperator();
        const owner = yield* seed(runtime, alice, false);
        const id = "22550000-0000-4000-8000-000000000091";
        const args = { owner: "directory", family: "replacement", operationId: id };
        const execute = (
          query: string,
          ...params: (string | number)[]
        ): ReturnType<typeof owner.exec> => native(() => owner.directory.exec(query, ...params));
        yield* execute(
          "INSERT INTO verified_email_routes VALUES('old@example.test',?,'original',7),('new@example.test',?,?,8)",
          alice.user,
          alice.user,
          id
        );
        yield* execute(
          "INSERT INTO identity_replacements(id,kind,scope,prior_key,next_key,occurred_at_ms,expires_at_ms,expected_user,user_id,revision,prior_reservation,state) VALUES(?,'email','','old@example.test','new@example.test',1,?,?,?,7,'original','reserved')",
          id,
          owner.now + 60000,
          alice.user,
          alice.user
        );
        expect((yield* submit({ ...args, action: "reconcile-reservation" })).status).toBe(409);
        yield* execute("UPDATE identity_replacements SET expires_at_ms=2 WHERE id=?", id);
        const settled = yield* submit({ ...args, action: "reconcile-reservation" });
        expect(settled.status).toBe(200);
        const read = yield* submit({ ...args, action: "inspect-reservation" });
        expect(yield* native(() => read.json())).toEqual({ outcome: "cancelled", deadlineMs: 2 });
        expect(
          yield* owner.exec("SELECT state FROM identity_change_outcomes WHERE id=?", id)
        ).toEqual([{ state: "cancelled" }]);
        expect(
          yield* execute(
            "SELECT reservation_id FROM verified_email_routes WHERE user_id=?",
            alice.user
          )
        ).toEqual([{ reservation_id: "original" }]);
      })
  );
  test.effect(
    "preserves the scoped original work when an operator inspects or nudges an uncertain send",
    () =>
      Effect.gen(function* () {
        const { submit, runtime } = yield* storageOperator();
        const owner = yield* seed(runtime, alice, false);
        const id = "22550000-0000-4000-8000-000000000018";
        const deadline = owner.now + 60000;
        yield* owner.exec(
          "INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,minimum_poll_seconds,outcome,state) VALUES(?,?,?,1,hex(zeroblob(32)),?,0,5,'committed','pending_approval')",
          id,
          id,
          alice.user,
          deadline
        );
        yield* owner.exec(
          "INSERT INTO login_email_proofs(pairing_id,work_id,address,revision,generation,requested_at_ms,expires_at_ms,offer_at_ms,state) VALUES(?,?,'fixture@example.test',1,1,?,?,?,'ambiguous')",
          id,
          id,
          owner.now,
          deadline,
          owner.now
        );
        const input = { owner: "user", userId: alice.user, family: "login-email", operationId: id };
        const receipt = yield* submit({ ...input, action: "inspect-work" });
        expect(yield* native(() => receipt.json())).toEqual({
          outcome: "ambiguous",
          dueMs: owner.now,
          deadlineMs: deadline,
        });
        expect((yield* submit({ ...input, action: "continue-work" })).status).toBe(409);
        yield* owner.exec(
          "UPDATE login_email_proofs SET state='awaiting_delivery' WHERE work_id=?",
          id
        );
        expect((yield* submit({ ...input, action: "continue-work" })).status).toBe(202);
        const evidence = yield* owner.exec(
          "SELECT operator,action,target,outcome FROM storage_operation_evidence WHERE target=? ORDER BY rowid",
          id
        );
        expect(evidence.map((row) => row.outcome)).toEqual(["observed", "refused", "pending"]);
        yield* owner.exec("DELETE FROM login_email_proofs WHERE work_id=?", id);
        expect(
          yield* owner.exec("SELECT id FROM storage_operation_evidence WHERE target=?", id)
        ).toEqual([]);
      })
  );
  test.effect("observes a committed publication after a different Price supersedes it", () =>
    Effect.gen(function* () {
      const { runtime, submit } = yield* storageOperator();
      const pricing = yield* native(() => runtime.getDurableObjectNamespace("PRICING", "core"));
      const catalog = pricing.getByName("pricing");
      const now = yield* Clock.currentTimeMillis;
      const first = "22550000-0000-4000-8000-000000000043";
      const publish = makeFixturePublisher(catalog, now);
      const original = "22550000-0000-4000-8000-000000000044";
      expect((yield* publish(first, original)).ok).toBe(true);
      expect(
        (yield* publish(
          "22550000-0000-4000-8000-000000000045",
          "22550000-0000-4000-8000-000000000046"
        )).ok
      ).toBe(true);
      const receipt = yield* submit({
        action: "reconcile-publication",
        owner: "pricing",
        operationId: first,
      });
      expect(yield* native(() => receipt.json())).toMatchObject({
        priceId: original,
        selected: 0,
        outcome: "committed",
      });
    })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "warns at five minutes, escalates by ten and retains unknown schema coverage after a completed wrap",
    () =>
      Effect.gen(function* () {
        const { runtime, submit, logs } = yield* storageOperator();
        const inspect = (): ReturnType<typeof submit> =>
          submit({ action: "inspect", owner: "maintenance" });
        yield* inspect();
        const registry = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Maintenance", {
            name: "core-maintenance-v1",
          })
        );
        const maintenance = yield* native(() =>
          runtime.getDurableObjectNamespace("MAINTENANCE", "core")
        );
        const id = "22550000-0000-4000-8000-000000000088";
        yield* native(() =>
          registry.exec("INSERT INTO lifetime_registry(user_id,registered_ms) VALUES(?,1)", id)
        );
        for (const [age, severity] of [
          [299000, "none"],
          [300000, "warning"],
          [600000, "critical"],
        ] as const) {
          const now = yield* Clock.currentTimeMillis;
          yield* native(() =>
            registry.exec(
              "UPDATE lifetime_registry SET registered_ms=? WHERE user_id=?",
              now - age,
              id
            )
          );
          yield* native(() =>
            registry.exec(
              "UPDATE watchdog_progress SET minute=-1,scheduled=-1,started_ms=?,wrapped_at=?",
              now - age,
              now
            )
          );
          const tick = yield* native(() =>
            maintenance
              .getByName("core-maintenance-v1")
              .fetch("https://maintenance.invalid/watchdog", {
                method: "POST",
                headers: { "x-maintenance-scheduled-at": String(now) },
              })
          );
          expect(tick.status).toBe(204);
          const receipt = yield* inspect();
          expect(yield* native(() => receipt.json())).toMatchObject({
            watchdog: { severity, unknown: 0 },
          });
          expect(
            logs.some((line) =>
              line.includes(
                "fidy.operational component=watchdog operation=coverage state=wrapped severity=" +
                  severity
              )
            )
          ).toBe(true);
        }
        expect(
          logs.filter((line) => line.includes("fidy.operational")).some((line) => line.includes(id))
        ).toBe(false);
      })
  );
  test.effect(
    "keeps the exact Price registration and deadline pending when its destination cannot prove a terminal outcome",
    () =>
      Effect.gen(function* () {
        const { runtime, submit } = yield* storageOperator();
        const pricing = yield* native(() => runtime.getDurableObjectNamespace("PRICING", "core"));
        const now = yield* Clock.currentTimeMillis;
        const deadline = now + 1200;
        const operationId = "22550000-0000-4000-8000-000000000086";
        const row = {
          userId: "22550000-0000-4000-8000-000000000087",
          operationId,
          admission: {
            kind: "renewal",
            previousPaidAttemptId: "22550000-0000-4000-8000-000000000089",
          },
          billingPeriod: "weekly",
          inputsDigest: "a".repeat(64),
          deadlineMs: deadline,
        };
        const registered = yield* native(() =>
          pricing.getByName("pricing").fetch("https://pricing.internal/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(row),
          })
        );
        expect(registered.status).toBe(200);
        const scope = { owner: "pricing", operationId };
        const original = yield* submit({ ...scope, action: "inspect-registration" });
        expect(yield* native(() => original.json())).toMatchObject({
          outcome: null,
          deadlineMs: deadline,
        });
        expect((yield* submit({ ...scope, action: "reconcile-registration" })).status).toBe(409);
        yield* Effect.sleep("1300 millis");
        const result = yield* submit({ ...scope, action: "reconcile-registration" });
        // An ordinary alarm can claim the next check first and keep the same pending operation.
        expect([202, 409]).toContain(result.status);
        const observed = yield* submit({ ...scope, action: "inspect-registration" });
        expect(yield* native(() => observed.json())).toMatchObject({
          outcome: null,
          deadlineMs: deadline,
        });
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "emits the monitored restricted-capacity critical signal and a native-only completed sweep",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeBrowserPlatform;
        const bytes = yield* Effect.scoped(measureDirectory(start));
        const { runtime, logs } = yield* session(start, {
          SQLITE_STORE_CAPACITY_BYTES: String(Math.floor(bytes / 0.85)),
        });
        const ns = yield* native(() => runtime.getDurableObjectNamespace("MAINTENANCE", "core"));
        const now = yield* Clock.currentTimeMillis;
        expect(
          (yield* native(() =>
            ns.getByName("core-maintenance-v1").fetch("https://maintenance.invalid/watchdog", {
              method: "POST",
              headers: {
                "x-maintenance-scheduled-at": String(now),
                "fidy-native-inspection": "1",
              },
            })
          )).status
        ).toBe(204);
        expect(
          logs.some((line) =>
            line.includes(
              "fidy.operational component=sqlite operation=directory state=restricted severity=critical"
            )
          )
        ).toBe(true);
        expect(
          logs.some((line) =>
            line.includes(
              "fidy.operational component=inspection-coverage operation=ownerInspections state=complete"
            )
          )
        ).toBe(true);
      })
  );
});
