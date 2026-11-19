import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { browser } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { webSignupDisclosure } from "../../src/shell/consent/operations";
import { UserId } from "../../src/core/identity/contract";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  for (const provider of ["google", "microsoft"] as const) {
    const start = `/web/providers/${provider}/start`;
    const complete = `/web/providers/${provider}/complete`;
    test.effect(
      provider +
        " preserves stable identity, exact consent, fixed recovery and Browser Login across independent authentication",
      () =>
        Effect.gen(function* () {
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
          expect(yield* native(() => store.exec("SELECT count(*) AS n FROM web_sessions"))).toEqual(
            [{ n: 0 }]
          );
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
  }
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
  if (provider === "google") expect(logs.join("\n")).toContain("signature_invalid");
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
    () => verifyProviderDiagnostics("microsoft"),
    { timeout: 20000 }
  );
  test.effect(
    "keeps configured Google credentials and protocol proofs out of exported diagnostics",
    () => verifyProviderDiagnostics("google"),
    { timeout: 20000 }
  );
  for (const provider of ["google", "microsoft"] as const) {
    test.effect(provider + " rejects foreign or absent Origin on state-changing browser work", () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const context = browser(runtime);
        const proof = yield* context.pair;
        for (const origin of ["https://other.example", ""]) {
          for (const operation of ["start", "complete", "status"]) {
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
            expect(res.status).toBe(403);
            expect(res.headers.get("set-cookie")).toBeNull();
            yield* native(() => res.arrayBuffer());
          }
        }
      })
    );
  }
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("a verified login to a retained erased identity leaves its new pairing pending", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeBrowserPlatform)();
      const { login, post } = browser(runtime);
      const subject = "protected-erased-subject";
      const complete = "/web/providers/google/complete";
      const joined = yield* login(subject, { provider: "google", scenario: "valid" });
      const created = yield* post(complete, joined.proof);
      expect(yield* native(() => created.json())).toMatchObject({ status: "created" });
      const directory = yield* native(() => runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" }));
      const next = yield* login(subject, { provider: "google", scenario: "valid", intent: "login" });
      expect(next.review).toEqual({ status: "verified" });
      yield* native(() => directory.exec(
        "INSERT INTO erasure_barriers SELECT user_id,'20000000-0000-4000-8000-000000000001',1 FROM provider_routes WHERE established=1"
      ));
      const refused = yield* post(complete, next.proof);
      const redemption = yield* post("/web/pairings/redeem", next.proof);
      expect(redemption.status).toBe(202);
      expect(redemption.headers.get("set-cookie")).toBeNull();
      expect(yield* native(() => redemption.json())).toMatchObject({ status: "pending_approval" });
      expect(refused.status).toBe(400);
      expect(yield* native(() => refused.json())).toEqual({ status: "invalid" });
      const held = yield* native(() => directory.exec("SELECT count(*) AS count FROM provider_routes JOIN erasure_barriers USING(user_id)"));
      expect(held).toEqual([{ count: 1 }]);
      yield* native(() => directory.exec("CREATE TRIGGER fail_pairing_bind BEFORE UPDATE OF user_id ON browser_pairings BEGIN SELECT RAISE(ABORT,'fixture_unavailable'); END"));
      const other = yield* login("unrelated", { provider: "google", scenario: "valid" });
      const outage = yield* post(complete, other.proof);
      expect(outage.status).toBe(503);
    })
  );
});
