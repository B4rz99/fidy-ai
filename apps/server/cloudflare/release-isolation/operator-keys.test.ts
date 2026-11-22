import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Option } from "effect";
import { expect } from "vitest";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { signAcceptanceRequest } from "./operations";
import { acceptanceLifetimeMs, acceptanceProofHeader } from "./contract";

const closedKeys = Effect.fn(function* (redirected: boolean) {
  const settings = {
    NATIVE_STORAGE_ADMISSION: "closed",
    RECOVERY_ISOLATION: "isolated",
    CLOUDFLARE_ACCESS_ISSUER: redirected
      ? "https://redirected.cloudflareaccess.com"
      : "https://fixture.cloudflareaccess.com",
    RELEASE_GIT_SHA: "a".repeat(40),
    SMOKE_PROOF: "b".repeat(64),
    BROWSER_ORIGIN: "https://app.fidyapp.com",
  };

  const runtime = yield* (yield* nativeBrowserPlatform)(undefined, [], settings);
  const core = yield* native(() => runtime.getWorker("core"));

  const { FIXTURE_PROVIDER: issuer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const invoke = Effect.fn(function* (role: string, path: string, body: string) {
    const assertion = yield* native(() =>
      issuer
        .fetch(
          "https://fixture.invalid/" +
            role +
            "-assertion" +
            (redirected ? "?scenario=redirected-issuer" : "")
        )
        .then((res) => res.text())
    );

    const request = new Request("https://core.internal/internal/" + path, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": assertion, "content-type": "application/json" },
      body,
    });

    request.headers.set(
      acceptanceProofHeader,
      yield* signAcceptanceRequest({
        request,
        environment: settings,
        boundary: "core",
        deadline: (yield* Clock.currentTimeMillis) + acceptanceLifetimeMs,
      })
    );

    return yield* native(() =>
      core.fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
      })
    );
  });

  const beta = yield* invoke("beta", "beta-pro", '{"action":"list"}');
  expect(beta.status).toBe(redirected ? 401 : 200);

  const listed = redirected ? Option.none() : Option.some(yield* native(() => beta.json()));
  expect(listed).toEqual(redirected ? Option.none() : Option.some({ entries: [], next: null }));
  expect((yield* invoke("reviewer", "sample-review", "{}")).status).toBe(redirected ? 401 : 400);
  expect((yield* invoke("reviewer", "beta-pro", '{"action":"list"}')).status).toBe(401);
  expect(
    yield* native(() =>
      issuer.fetch("https://fixture.invalid/followed-key-count").then((res) => res.json())
    )
  ).toBe(0);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "verifies signed beta and sample operators in a closed workerd installation using their exact pinned issuer",
    () => closedKeys(false)
  );
  test.effect(
    "refuses both operators if their pinned signing-key endpoint redirects and never fetches the second endpoint",
    () => closedKeys(true)
  );
});
