import type { Miniflare } from "miniflare";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ProPage } from "../../src/shell/pro-grants/contract";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";

type Reply = Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>>;

const scenario = Effect.gen(function* () {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const first = yield* seed(runtime, alice, false);
  yield* seed(runtime, bob, false);

  const { FIXTURE_PROVIDER: signer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const token = (name: string): Effect.Effect<string> =>
    native(() =>
      signer
        .fetch("https://fixture.invalid/" + name + "-assertion")
        .then((response) => response.text())
    );

  const send = (assertion: string, cmd: unknown): Reply =>
    native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/internal/beta-pro", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": assertion,
          "content-type": "application/json",
          connection: "close",
        },
        body: JSON.stringify(cmd),
      })
    );

  const command = {
    action: "grant",
    userId: alice.user,
    requestId: "10000000-0000-4000-8000-000000000100",
  };

  yield* Effect.forEach(
    ["reviewer", "support", "erasure"],
    Effect.fnUntraced(function* (role) {
      expect((yield* send(yield* token(role), command)).status).toBe(401);
    }),
    { discard: true }
  );

  const wrongMember = yield* native(() =>
    signer
      .fetch("https://fixture.invalid/beta-assertion?scenario=unassigned")
      .then((response) => response.text())
  );

  expect((yield* send(wrongMember, command)).status).toBe(401);
  const proof = yield* token("beta");
  const list = (): Reply => send(proof, { action: "list" });
  const granted = yield* send(proof, command);
  expect(granted.status).toBe(200);
  expect(yield* native(() => granted.json())).toEqual({ userId: alice.user, action: "grant" });
  expect((yield* send(proof, command)).status).toBe(200);

  const revoked = {
    ...command,
    requestId: "10000000-0000-4000-8000-000000000101",
    action: "revoke",
  };

  expect((yield* send(proof, revoked)).status).toBe(200);
  expect((yield* send(proof, command)).status).toBe(200);
  expect((yield* send(proof, { ...command, action: "revoke" })).status).toBe(409);
  expect(yield* first.exec("SELECT action FROM pro_grant_events ORDER BY sequence")).toEqual([
    { action: "grant" },
    { action: "revoke" },
  ]);
  expect(
    yield* first.exec(
      "SELECT DISTINCT operator,operator_issuer,operator_subject FROM pro_grant_events"
    )
  ).toEqual([
    {
      operator: "beta@example.test",
      operator_issuer: "https://fixture.cloudflareaccess.com",
      operator_subject: "fixture-operator",
    },
  ]);
  const none = yield* list();
  expect(yield* native(() => none.json())).toEqual({ entries: [], next: null });
  const second = { ...command, userId: bob.user };
  expect((yield* send(proof, second)).status).toBe(200);
  const current = yield* list();
  expect(yield* native(() => current.json())).toEqual({
    entries: [{ userId: bob.user, action: "grant" }],
    next: null,
  });

  const registry = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: "core-maintenance-v1" })
  );

  yield* native(() =>
    registry.exec(
      "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<17) INSERT INTO lifetime_registry(user_id,retired,erasure_reference) SELECT printf('20000000-0000-4000-8000-%012d',i),1,'erased' FROM n"
    )
  );
  const paged = yield* list();
  const firstPage = yield* Schema.decodeUnknownEffect(ProPage)(yield* native(() => paged.json()));
  expect(firstPage.entries).toEqual([{ userId: bob.user, action: "grant" }]);
  expect(firstPage.next).not.toBeNull();
  const tail = yield* send(proof, { action: "list", cursor: firstPage.next });
  expect(yield* native(() => tail.json())).toEqual({ entries: [], next: null });
  yield* native(() => registry.exec("ALTER TABLE lifetime_registry RENAME TO offline"));
  expect((yield* list()).status).toBe(503);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) =>
  test.effect(
    "admits only the exact beta operator, lists current native grants and replays original decisions without reversing a later revoke",
    () => scenario
  )
);

const mailbox = "verified@example.test";

const mailboxOwnership = Effect.gen(function* () {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const first = yield* seed(runtime, alice, false);
  const other = yield* seed(runtime, bob, false);

  const { FIXTURE_PROVIDER: signer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const proof = yield* native(() =>
    signer.fetch("https://fixture.invalid/beta-assertion").then((response) => response.text())
  );

  const call = (command: unknown): Reply =>
    native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/internal/beta-pro", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": proof,
          "content-type": "application/json",
          connection: "close",
        },
        body: JSON.stringify(command),
      })
    );

  const email = { action: "resolve", email: "  VERIFIED@example.TEST " };
  expect((yield* call(email)).status).toBe(404);
  yield* native(() =>
    first.directory.exec(
      "INSERT INTO verified_email_routes VALUES (?,?,?,2)",
      mailbox,
      alice.user,
      "fixture"
    )
  );
  expect((yield* call(email)).status).toBe(404);
  yield* first.exec(
    "INSERT INTO verified_email_credentials VALUES(?,?,2,?)",
    alice.user,
    mailbox,
    first.now
  );
  const resolved = yield* call(email);
  expect(yield* native(() => resolved.json())).toEqual({ userId: alice.user, revision: 2 });

  const command = {
    action: "grant",
    userId: alice.user,
    requestId: "10000000-0000-4000-8000-000000000115",
    mailbox: { email: mailbox, revision: 2 },
  };

  yield* first.exec("UPDATE verified_email_credentials SET revision=3");
  expect((yield* call(command)).status).toBe(404);
  expect((yield* call(email)).status).toBe(404);
  yield* first.exec("DELETE FROM verified_email_credentials");
  yield* native(() =>
    first.directory.exec("UPDATE verified_email_routes SET user_id=?,revision=1", bob.user)
  );
  yield* other.exec(
    "INSERT INTO verified_email_credentials VALUES(?,?,1,?)",
    bob.user,
    mailbox,
    other.now
  );
  expect((yield* call(command)).status).toBe(404);
  const newOwner = yield* call(email);
  expect(yield* native(() => newOwner.json())).toEqual({ userId: bob.user, revision: 1 });

  yield* Effect.forEach(
    [first, other],
    Effect.fnUntraced(function* (store) {
      expect(yield* store.exec("SELECT count(*) n FROM pro_grant_events")).toEqual([{ n: 0 }]);
    }),
    { discard: true }
  );
});

const underPressure = Effect.gen(function* () {
  const runtime = yield* (yield* nativeBrowserPlatform)("500000");
  const first = yield* seed(runtime, alice, false);

  const { FIXTURE_PROVIDER: signer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const proof = yield* native(() =>
    signer.fetch("https://fixture.invalid/beta-assertion").then((response) => response.text())
  );

  const send = (action: string): Reply =>
    native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/internal/beta-pro", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": proof,
          "content-type": "application/json",
          connection: "close",
        },
        body: JSON.stringify({
          action,
          userId: alice.user,
          requestId: "10000000-0000-4000-8000-000000000110",
        }),
      })
    );

  expect((yield* send("grant")).status).toBe(503);
  expect(yield* first.exec("SELECT sequence FROM pro_grant_events")).toEqual([]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "checks independent verified mailboxes in the Directory and selected User at resolution and again at commit, including replacement",
    () => mailboxOwnership
  );
  test.effect(
    "refuses a Pro grant under native storage pressure before publishing evidence",
    () => underPressure
  );
});
