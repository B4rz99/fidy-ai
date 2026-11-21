import { NodeFileSystem } from "@effect/platform-node";
import { Array as Arr, Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { browser, loginOnlyBrowser } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform, nativeLoginPlatform } from "../user-store.test-fixture";
import { webSignupDisclosure } from "../../src/shell/consent/operations";
import { UserId } from "../../src/core/identity/contract";

type Storage = Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>;

type OriginProbe = Readonly<{
  runtime: Miniflare;
  context: ReturnType<typeof browser>;
  proof: Effect.Success<ReturnType<typeof browser>["pair"]>;
  provider: "google" | "microsoft";
}>;

const refusedOrigin = ({
  runtime,
  context,
  proof,
  provider,
}: OriginProbe): ((
  request: readonly [string, string]
) => Effect.Effect<readonly [number, boolean]>) =>
  Effect.fnUntraced(function* ([origin, operation]) {
    const headers = new Headers(context.headers);

    if (origin === "") headers.delete("origin");
    else headers.set("origin", origin);

    const res = yield* native(() =>
      runtime.dispatchFetch(context.api + "/web/providers/" + provider + "/" + operation, {
        method: "POST",
        headers,
        body: JSON.stringify(proof),
      })
    );

    yield* native(() => res.arrayBuffer());

    return [res.status, res.headers.has("set-cookie")] as const;
  });

type LostCompletion = Readonly<{
  existing: ReturnType<typeof loginOnlyBrowser>;
  subject: string;
  store: Storage;
  directory: Storage;
  post: ReturnType<typeof browser>["post"];
  complete: string;
}>;

const loseCompletion = ({
  existing,
  subject,
  store,
  directory,
  post,
  complete,
}: LostCompletion): ((fenced: boolean) => Effect.Effect<void, Schema.SchemaError>) =>
  Effect.fnUntraced(function* (fenced) {
    const attempt = yield* existing.login(subject, { provider: "google", scenario: "valid" });
    expect(attempt.review).toEqual({ status: "verified" });
    yield* native(() => store.exec("CREATE TABLE lose_provider_completion_reply(marker INTEGER)"));

    if (fenced) {
      yield* native(() =>
        directory.exec(
          "CREATE TRIGGER concurrent_fence AFTER UPDATE OF state ON provider_attempts WHEN NEW.state='bound' BEGIN INSERT INTO erasure_barriers(user_id,reference,requested_at_ms) SELECT user_id,'20000000-0000-4000-8000-000000000004',1 FROM browser_pairings WHERE id=NEW.pairing_id; END"
        )
      );
    }

    const lost = yield* post(complete, attempt.proof);
    expect(lost.status).toBe(fenced ? 400 : 503);
    expect(yield* native(() => lost.json())).toEqual({
      status: fenced ? "invalid" : "unavailable",
    });
    expect(
      yield* native(() =>
        store.exec("SELECT name FROM sqlite_schema WHERE name='lose_provider_completion_reply'")
      )
    ).toEqual([]);
  });

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect.each(["google", "microsoft"] as const)(
    "%s preserves stable identity, exact consent, fixed recovery and Browser Login across independent authentication",
    (provider) =>
      Effect.gen(function* () {
        const start = `/web/providers/${provider}/start`;
        const complete = `/web/providers/${provider}/complete`;
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const { login, post, pair } = browser(runtime);
        const unsigned = yield* pair;

        const bad = yield* post(start, {
          ...unsigned,
          intent: "signup",
          consentRevision: "stale",
        });

        expect(bad.status).toBe(400);
        yield* native(() => bad.arrayBuffer());
        const flow = yield* login("stable", { provider, scenario: "valid" });
        expect(flow.review).toEqual({ status: "verified" });

        const crossed = yield* post(complete, {
          ...flow.proof,
          privateVerifier: unsigned.privateVerifier,
        });

        expect(crossed.status).toBe(400);
        yield* native(() => crossed.arrayBuffer());
        const created = yield* post(complete, flow.proof);
        const result = yield* native(() => created.json());
        expect(
          Schema.is(
            Schema.Struct({
              status: Schema.Literal("created"),
              backupRecoveryCode: Schema.String,
            })
          )(result)
        ).toBe(true);
        expect(created.headers.get("set-cookie")).toBeNull();

        const directory = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        const [owner] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ user_id: UserId }))
        )(yield* native(() => directory.exec("SELECT user_id FROM provider_routes")));

        if (owner === undefined) return yield* Effect.die("Missing signup");

        const store = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: owner.user_id })
        );

        const before = yield* native(() =>
          store.exec(
            "SELECT created_at_ms,trial_started_at_ms,trial_ends_at_ms,lifetime_registered FROM users"
          )
        );

        expect(yield* native(() => store.exec("SELECT count(*) AS n FROM web_sessions"))).toEqual([
          { n: 0 },
        ]);
        expect(
          yield* native(() =>
            store.exec(
              "SELECT json_extract(disclosure_json,'$.revision') AS revision FROM consent_history"
            )
          )
        ).toEqual([{ revision: webSignupDisclosure().revision }]);
        const next = yield* login("stable", { provider, scenario: "changedEmail" });
        const returning = yield* post(complete, next.proof);
        expect(yield* native(() => returning.json())).toEqual({ status: "approved" });
        expect(
          yield* native(() =>
            store.exec(
              "SELECT created_at_ms,trial_started_at_ms,trial_ends_at_ms,lifetime_registered FROM users"
            )
          )
        ).toEqual(before);
        expect(
          yield* native(() => store.exec("SELECT revision FROM backup_recovery_credentials"))
        ).toEqual([{ revision: 1 }]);
        const redeemed = yield* post("/web/pairings/redeem", next.proof);
        expect(redeemed.headers.get("set-cookie")).toContain("__Host-fidy_session=");
        yield* native(() => redeemed.arrayBuffer());
        const missing = yield* login("stable", { provider, scenario: "missingEmail" });
        const unchanged = yield* post(complete, missing.proof);
        expect(yield* native(() => unchanged.json())).toEqual({ status: "approved" });

        const different = yield* login(provider === "microsoft" ? "stable" : "different", {
          provider,
          scenario: provider === "google" ? "valid" : "enterprise",
        });

        const separate = yield* post(complete, different.proof);
        expect(yield* native(() => separate.json())).toMatchObject({ status: "created" });
        expect(
          yield* native(() =>
            directory.exec("SELECT count(DISTINCT user_id) AS n FROM provider_routes")
          )
        ).toEqual([{ n: 2 }]);
      })
  );
});

const verifyProviderDiagnostics = Effect.fn(function* (provider: "google" | "microsoft") {
  const logs: Array<string> = [];
  const runtime = yield* (yield* nativeBrowserPlatform)("1000000000", logs);
  const context = browser(runtime);

  const refused = yield* context.login("private-subject", {
    provider,
    scenario: "signature",
  });

  expect(refused.review).toEqual({ status: "rejected" });

  yield* Effect.sync(() => expect(logs.join("\n")).toContain("signature_invalid")).pipe(
    Effect.when(Effect.succeed(provider === "google"))
  );

  const verified = yield* context.login("private-verified-subject", {
    provider,
    scenario: "valid",
  });

  expect(verified.review).toEqual({ status: "verified" });
  const diagnostics = logs.join("\n");
  expect(diagnostics).toContain("worker.public.fetch");

  for (const secret of [
    verified.attempt,
    verified.proof.privateVerifier,
    "private-verified-subject",
    refused.attempt,
    refused.proof.privateVerifier,
    "private-subject",
    "local-provider-fixture",
  ]) {
    expect(diagnostics).not.toContain(secret);
  }

  const stalled = yield* context.login("stalled-subject", {
    provider,
    scenario: "timeout",
  });

  expect(stalled.review).toEqual({ status: "rejected" });
  const denied = yield* context.post(`/web/providers/${provider}/complete`, stalled.proof);
  expect(denied.status).toBe(400);
  yield* native(() => denied.arrayBuffer());
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "keeps configured Microsoft credentials and protocol proofs out of exported diagnostics",
    () => verifyProviderDiagnostics("microsoft")
  );
  test.effect(
    "keeps configured Google credentials and protocol proofs out of exported diagnostics",
    () => verifyProviderDiagnostics("google")
  );

  test.effect.each(["google", "microsoft"] as const)(
    "%s rejects foreign or absent Origin on state-changing browser work",
    (provider) =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const context = browser(runtime);
        const proof = yield* context.pair;

        const refusals = yield* Effect.forEach(
          Arr.cartesian(["https://other.example", ""], ["start", "complete", "status"]),
          refusedOrigin({ runtime, context, proof, provider })
        );

        expect(refusals).toEqual([
          [403, false],
          [403, false],
          [403, false],
          [403, false],
          [403, false],
          [403, false],
        ]);
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("a verified login to a retained erased identity leaves its new pairing pending", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeBrowserPlatform)();
      const { login, post } = browser(runtime);
      const existing = loginOnlyBrowser(runtime);
      const subject = "protected-erased-subject";
      const complete = "/web/providers/google/complete";
      const joined = yield* login(subject, { provider: "google", scenario: "valid" });
      const created = yield* post(complete, joined.proof);
      expect(yield* native(() => created.json())).toMatchObject({ status: "created" });

      const directory = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
      );

      const next = yield* existing.login(subject, {
        provider: "google",
        scenario: "valid",
      });

      expect(next.review).toEqual({ status: "verified" });
      yield* native(() =>
        directory.exec(
          "INSERT INTO erasure_barriers(user_id,reference,requested_at_ms) SELECT user_id,'20000000-0000-4000-8000-000000000001',1 FROM provider_routes WHERE established=1"
        )
      );
      const refused = yield* post(complete, next.proof);
      const redemption = yield* post("/web/pairings/redeem", next.proof);
      expect(redemption.status).toBe(202);
      expect(redemption.headers.get("set-cookie")).toBeNull();
      expect(yield* native(() => redemption.json())).toMatchObject({ status: "pending_approval" });
      expect(refused.status).toBe(400);
      expect(yield* native(() => refused.json())).toEqual({ status: "invalid" });

      const held = yield* native(() =>
        directory.exec(
          "SELECT count(*) AS count FROM provider_routes JOIN erasure_barriers USING(user_id)"
        )
      );

      expect(held).toEqual([{ count: 1 }]);
      const returningSubject = "fenced-after-reservation";
      const first = yield* login(returningSubject, { provider: "google", scenario: "valid" });
      const ready = yield* post(complete, first.proof);
      expect(yield* native(() => ready.json())).toMatchObject({ status: "created" });

      const racing = yield* existing.login(returningSubject, {
        provider: "google",
        scenario: "valid",
      });

      yield* native(() =>
        directory.exec(
          "CREATE TRIGGER fence_after_bind AFTER UPDATE OF state ON provider_attempts WHEN NEW.state='bound' BEGIN INSERT INTO erasure_barriers(user_id,reference,requested_at_ms) SELECT user_id,'20000000-0000-4000-8000-000000000002',1 FROM browser_pairings WHERE id=NEW.pairing_id; END"
        )
      );
      const raced = yield* post(complete, racing.proof);
      expect(raced.status).toBe(400);
      expect(yield* native(() => raced.json())).toEqual({ status: "invalid" });
      yield* native(() => directory.exec("DROP TRIGGER fence_after_bind"));
      yield* native(() =>
        directory.exec(
          "CREATE TRIGGER fail_pairing_bind BEFORE UPDATE OF user_id ON browser_pairings BEGIN SELECT RAISE(ABORT,'fixture_unavailable'); END"
        )
      );
      const other = yield* login("unrelated", { provider: "google", scenario: "valid" });
      const outage = yield* post(complete, other.proof);
      expect(outage.status).toBe(503);
    })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("a lost UserStore completion uses the exact concurrent erasure barrier", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeLoginPlatform)();
      const { login, post } = browser(runtime);
      const subject = "lost-provider-completion";
      const complete = "/web/providers/google/complete";
      const joined = yield* login(subject, { provider: "google", scenario: "valid" });
      const created = yield* post(complete, joined.proof);
      expect(yield* native(() => created.json())).toMatchObject({ status: "created" });

      const directory = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
      );

      const [row] = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ user_id: UserId }))
      )(
        yield* native(() =>
          directory.exec("SELECT user_id FROM browser_pairings WHERE id=?", joined.proof.pairingId)
        )
      );

      if (row === undefined) return yield* Effect.die("Missing original User");

      const store = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: row.user_id })
      );

      const existing = loginOnlyBrowser(runtime);

      yield* Effect.forEach(
        [false, true],
        loseCompletion({ existing, subject, store, directory, post, complete }),
        { discard: true }
      );
    })
  );
});
