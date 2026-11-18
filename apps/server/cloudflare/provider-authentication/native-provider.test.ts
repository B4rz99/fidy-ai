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

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  for (const provider of ["google", "microsoft"] as const) {
    test.effect(
      provider + " keeps failed exchanges bounded and writes only redacted diagnostic reasons",
      () =>
        Effect.gen(function* () {
          const logs: Array<string> = [];
          const runtime = yield* (yield* nativeBrowserPlatform)("1000000000", logs);
          const context = browser(runtime);
          const refused = yield* context.login("private-subject", {
            provider,
            scenario: "signature",
          });
          expect(refused.review).toEqual({ status: "rejected" });
          if (provider === "google") expect(logs.join("\n")).toContain("signature_invalid");
          for (const secret of [
            refused.attempt,
            refused.proof.privateVerifier,
            "private-subject",
            "local-provider-fixture",
          ]) {
            expect(logs.join("\n")).not.toContain(secret);
          }
          const stalled = yield* context.login("stalled-subject", {
            provider,
            scenario: "timeout",
          });
          expect(stalled.review).toEqual({ status: "rejected" });
          const denied = yield* context.post(`/web/providers/${provider}/complete`, stalled.proof);
          expect(denied.status).toBe(400);
          yield* native(() => denied.arrayBuffer());
        }),
      { timeout: 20000 }
    );
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
