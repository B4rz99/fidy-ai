import { webSignupDisclosure } from "../../src/shell/consent/operations";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { browser } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { UserId } from "../../src/core/identity/contract";
import type { AuthenticationProvider } from "../../src/shell/provider-authentication/contract";

const invalidStatus = 400;

const unavailableStatus = 503;

const pendingStatus = 202;

const redirectStatus = 303;

const verifierLength = 43;

const common = ["nonce", "audience", "issuer", "expiry", "signature", "deny", "emptySubject"];

const microsoftOnly = ["invalidTenant", "foreignTenant", "keyIssuer", "version", "future"];

const refusedProvider = Effect.fn(function* (provider: AuthenticationProvider, scenario: string) {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const { login, post } = browser(runtime);
  const attempt = yield* login("refused", { provider, scenario });
  expect(attempt.review).toEqual({ status: "rejected" });
  const denied = yield* post(`/web/providers/${provider}/complete`, attempt.proof);
  expect(denied.status).toBe(invalidStatus);
  yield* native(() => denied.arrayBuffer());

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  expect(yield* native(() => directory.exec("SELECT count(*) AS n FROM provider_routes"))).toEqual([
    { n: 0 },
  ]);
  const pending = yield* post("/web/pairings/redeem", attempt.proof);
  expect(pending.status).toBe(pendingStatus);
  expect(pending.headers.get("set-cookie")).toBeNull();
  yield* native(() => pending.arrayBuffer());
});

const failures = [
  "BEFORE INSERT ON users",
  "BEFORE INSERT ON provider_credentials",
  "BEFORE INSERT ON consent_history",
  "BEFORE INSERT ON backup_recovery_credentials",
  "BEFORE UPDATE OF outcome ON browser_handoffs",
] as const;

const failEnrollment = (
  store: Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>,
  complete: () => ReturnType<ReturnType<typeof browser>["post"]>
): ((failure: string) => Effect.Effect<void>) =>
  Effect.fnUntraced(function* (failure) {
    yield* native(() =>
      store.exec("CREATE TRIGGER fail_enroll " + failure + " BEGIN SELECT RAISE(IGNORE); END")
    );
    const res = yield* complete();
    expect(res.status).toBe(unavailableStatus);
    yield* native(() => res.arrayBuffer());
    expect(
      yield* native(() =>
        store.exec(
          "SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM provider_credentials) AS credentials,(SELECT count(*) FROM consent_history) AS consents,(SELECT count(*) FROM backup_recovery_credentials) AS recovery"
        )
      )
    ).toEqual([{ users: 0, credentials: 0, consents: 0, recovery: 0 }]);
    yield* native(() => store.exec("DROP TRIGGER fail_enroll"));
  });

const rollbackEnrollment = Effect.fn(function* (provider: AuthenticationProvider) {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const { login, post } = browser(runtime);
  const { proof } = yield* login("atomic-rollback", { provider, scenario: "valid" });

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  yield* native(() =>
    directory.exec(
      "CREATE TRIGGER pause_recovery BEFORE INSERT ON recovery_routes BEGIN SELECT RAISE(ABORT,'pause'); END"
    )
  );

  const complete = (): ReturnType<typeof post> =>
    post(`/web/providers/${provider}/complete`, proof);

  const paused = yield* complete();
  expect(paused.status).toBe(unavailableStatus);
  yield* native(() => paused.arrayBuffer());

  const [user] = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ user_id: UserId }))
  )(yield* native(() => directory.exec("SELECT user_id FROM provider_routes")));

  if (user === undefined) return yield* Effect.die("Missing reservation");

  const store = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: user.user_id })
  );

  yield* native(() => directory.exec("DROP TRIGGER pause_recovery"));

  yield* Effect.forEach(failures, failEnrollment(store, complete), { discard: true });

  const success = yield* complete();
  expect(yield* native(() => success.json())).toMatchObject({ status: "created" });
  yield* native(() =>
    directory.exec("ALTER TABLE provider_routes RENAME TO offline_provider_routes")
  );
  const offline = yield* complete();
  expect(offline.status).toBe(unavailableStatus);
  yield* native(() => offline.arrayBuffer());
  yield* native(() =>
    directory.exec("ALTER TABLE offline_provider_routes RENAME TO provider_routes")
  );
  yield* native(() => directory.exec("UPDATE provider_attempts SET expires_at_ms=0"));
  const expired = yield* complete();
  expect(expired.status).toBe(invalidStatus);
  yield* native(() => expired.arrayBuffer());
  expect(yield* native(() => directory.exec("SELECT user_id FROM provider_routes"))).toEqual([
    { user_id: user.user_id },
  ]);
});

const requireConsent = Effect.fn(function* (provider: AuthenticationProvider) {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const { pair, post, begin } = browser(runtime);
  const proof = yield* pair;
  const start = `/web/providers/${provider}/start`;

  yield* Effect.forEach(
    [
      { ...proof, intent: "signup", consentRevision: "outdated" },
      {
        ...proof,
        privateVerifier: "x".repeat(verifierLength),
        intent: "signup",
        consentRevision: webSignupDisclosure().revision,
      },
    ],
    Effect.fnUntraced(function* (data) {
      const refused = yield* post(start, data);
      expect(refused.status).toBe(invalidStatus);
      expect(refused.headers.get("set-cookie")).toBeNull();
      yield* native(() => refused.arrayBuffer());
    }),
    { discard: true }
  );

  const challenge = yield* begin(provider);
  expect(challenge.cookie).toContain("__Host-fidy_" + provider + "=");
  expect(challenge.authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(challenge.authorization.searchParams.get("scope")).toBe("openid email");

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  expect(yield* native(() => directory.exec("SELECT count(*) AS n FROM provider_routes"))).toEqual([
    { n: 0 },
  ]);
});

const originalBrowser = Effect.fn(function* (provider: AuthenticationProvider) {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const { api, headers, post, begin, login } = browser(runtime);
  const challenge = yield* begin(provider);
  const state = challenge.authorization.searchParams.get("state") ?? "";
  const nonce = challenge.authorization.searchParams.get("nonce") ?? "";
  const other = provider === "google" ? "microsoft" : "google";

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  yield* Effect.forEach(
    [
      [other, state, challenge.cookie],
      [provider, state, ""],
      [provider, "a".repeat(verifierLength), challenge.cookie],
    ],
    Effect.fnUntraced(function* ([destination, actualState, cookie]) {
      const callback = yield* native(() =>
        runtime.dispatchFetch(
          api +
            "/providers/" +
            destination +
            "/callback?" +
            new URLSearchParams({
              state: actualState ?? "",
              code: nonce + ".current.valid",
            }).toString(),
          { headers: { ...headers, cookie: cookie ?? "" }, redirect: "manual" }
        )
      );

      expect(callback.status).toBe(redirectStatus);
      expect(callback.headers.get("set-cookie")).toBeNull();
      yield* native(() => callback.arrayBuffer());
    }),
    { discard: true }
  );

  expect(yield* native(() => directory.exec("SELECT state FROM provider_attempts"))).toEqual([
    { state: "pending" },
  ]);
  yield* native(() => directory.exec("UPDATE provider_attempts SET expires_at_ms=0"));
  const expired = yield* post(`/web/providers/${provider}/complete`, challenge.proof);
  expect(expired.status).toBe(invalidStatus);
  yield* native(() => expired.arrayBuffer());
  const fresh = yield* login("fresh", { provider, scenario: "valid" });
  const created = yield* post(`/web/providers/${provider}/complete`, fresh.proof);
  expect(yield* native(() => created.json())).toMatchObject({ status: "created" });
});

const competingBrowsers = Effect.fn(function* (provider: AuthenticationProvider) {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const { login, post } = browser(runtime);
  const first = yield* login("contended", { provider, scenario: "valid" });
  const second = yield* login("contended", { provider, scenario: "valid" });

  const calls = yield* Effect.all(
    [
      post(`/web/providers/${provider}/complete`, first.proof),
      post(`/web/providers/${provider}/complete`, second.proof),
    ],
    { concurrency: 2 }
  );

  const results = yield* Effect.forEach(calls, (response) => native(() => response.json()));
  expect(
    results.filter(Schema.is(Schema.Struct({ backupRecoveryCode: Schema.String })))
  ).toHaveLength(1);

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  expect(yield* native(() => directory.exec("SELECT count(*) AS n FROM provider_routes"))).toEqual([
    { n: 1 },
  ]);
});

export const nativeProviderRefusals = (provider: AuthenticationProvider): void => {
  it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
    for (const scenario of provider === "google" ? common : common.concat(microsoftOnly)) {
      test.effect(provider + " refuses " + scenario + " before any User or session exists", () =>
        refusedProvider(provider, scenario)
      );
    }
  });
};

export const nativeProviderRollback = (provider: AuthenticationProvider): void => {
  it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
    test.effect(
      "rolls back every enrollment fact and refuses wrong, expired and unavailable routing without releasing the reservation",
      () => rollbackEnrollment(provider)
    );
  });
};

export const nativeProviderBrowserGuards = (provider: AuthenticationProvider): void => {
  it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
    test.effect(
      provider +
        " requires a current private pairing and explicit Consent before issuing a browser-bound authorization request",
      () => requireConsent(provider)
    );
    test.effect(
      provider +
        " refuses substituted browser state, wrong-provider exchange, and expired handoffs; another browser can still sign up",
      () => originalBrowser(provider)
    );
    test.effect(
      provider +
        " issues one recovery code when competing browsers first establish the same identity",
      () => competingBrowsers(provider)
    );
  });
};
