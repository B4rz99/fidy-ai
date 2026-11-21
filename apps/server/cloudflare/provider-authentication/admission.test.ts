import publicWorker from "../public-worker";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Array as Arr, Clock, Effect, Schema } from "effect";
import type { Miniflare, Response } from "miniflare";
import { expect } from "vitest";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { browser } from "../browser-bootstrap.test-fixture";
import { webSignupDisclosure } from "../../src/shell/consent/operations";

const drain = (response: Pick<Response, "arrayBuffer">): Effect.Effect<ArrayBuffer> =>
  native(() => response.arrayBuffer());

const pollStatus =
  (
    runtime: Miniflare,
    context: ReturnType<typeof browser>,
    payload: string
  ): ((index: number) => Effect.Effect<Response>) =>
  (index) =>
    native(() =>
      runtime.dispatchFetch(context.api + "/web/providers/google/status", {
        method: "POST",
        headers: { ...context.headers, "CF-Connecting-IP": "192.0.2." + index },
        body: payload,
      })
    ).pipe(Effect.tap(drain));

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "applies shared source and expensive-request limits before provider work and ignores client-supplied source keys",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const context = browser(runtime);
        const proof = yield* context.pair;

        const directory = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        const deadline = (yield* Clock.currentTimeMillis) + 60000;

        const send = (): ReturnType<typeof context.post> =>
          native(() =>
            runtime.dispatchFetch(context.api + "/web/providers/disclosure", {
              headers: { ...context.headers, "x-provider-source": "f".repeat(64) },
            })
          );

        const first = yield* send();
        expect(first.status).toBe(200);
        yield* native(() => first.arrayBuffer());
        yield* native(() =>
          directory.exec(
            "WITH RECURSIVE sequence(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<118) INSERT INTO bootstrap_admissions(scope,expires_at_ms) SELECT (SELECT scope FROM bootstrap_admissions WHERE scope LIKE 'source:%' LIMIT 1),? FROM sequence",
            deadline
          )
        );
        const limited = yield* send();
        expect(limited.status).toBe(429);
        yield* native(() => limited.arrayBuffer());
        yield* native(() => directory.exec("DELETE FROM bootstrap_admissions"));
        yield* native(() =>
          directory.exec(
            "WITH RECURSIVE sequence(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<300) INSERT INTO bootstrap_admissions(scope,expires_at_ms) SELECT 'exchanges',? FROM sequence",
            deadline
          )
        );

        const expensive = yield* context.post("/web/providers/google/start", {
          ...proof,
          intent: "signup",
          consentRevision: webSignupDisclosure().revision,
        });

        expect(expensive.status).toBe(429);
        yield* native(() => expensive.arrayBuffer());
        expect(
          yield* native(() => directory.exec("SELECT count(*) AS n FROM provider_attempts"))
        ).toEqual([{ n: 0 }]);
      })
  );
  test.effect(
    "atomically admits only the remaining global slot, sweeps expired windows, and reports unavailable admission storage",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const context = browser(runtime);
        yield* context.pair;

        const directory = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        yield* native(() => directory.exec("DELETE FROM bootstrap_admissions"));
        const deadline = (yield* Clock.currentTimeMillis) + 60000;
        yield* native(() =>
          directory.exec(
            "WITH RECURSIVE seq(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1199) INSERT INTO bootstrap_admissions(scope,expires_at_ms) SELECT 'global',? FROM seq",
            deadline
          )
        );
        yield* native(() =>
          directory.exec(
            "INSERT INTO bootstrap_admissions(scope,expires_at_ms) VALUES('expired',0)"
          )
        );

        const send = (source: string): ReturnType<typeof context.post> =>
          native(() =>
            runtime.dispatchFetch(context.api + "/web/providers/disclosure", {
              headers: { ...context.headers, "CF-Connecting-IP": source },
            })
          );

        const results = yield* Effect.all([send("192.0.2.3"), send("192.0.2.4")], {
          concurrency: 2,
        });

        expect(
          results.map((response) => response.status).sort((left, right) => left - right)
        ).toEqual([200, 429]);

        yield* Effect.forEach(results, drain, { discard: true });
        expect(
          yield* native(() =>
            directory.exec("SELECT count(*) AS n FROM bootstrap_admissions WHERE scope='expired'")
          )
        ).toEqual([{ n: 0 }]);
        yield* native(() =>
          directory.exec("ALTER TABLE bootstrap_admissions RENAME TO offline_admission")
        );
        const offline = yield* send("192.0.2.5");
        expect(offline.status).toBe(503);
        yield* native(() => offline.arrayBuffer());
      })
  );
  test.effect(
    "shares five polls per private verifier across sources and refuses missing source evidence",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();
        const context = browser(runtime);
        const proof = yield* context.pair;
        const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(proof);

        const polls = yield* Effect.forEach(Arr.range(0, 5), pollStatus(runtime, context, payload));

        expect(polls.map(({ status }) => status)).toEqual([400, 400, 400, 400, 400, 429]);

        const headers = new Headers(context.headers);
        headers.set("CF-Connecting-IP", "");
        headers.set("x-provider-source", "f".repeat(64));

        const missing = yield* native(() =>
          publicWorker.fetch(
            new Request(context.api + "/web/providers/google/status", {
              method: "POST",
              headers,
              body: payload,
            }),
            {
              RELEASE_GIT_SHA: "f".repeat(40),
              CORE: { fetch: () => Promise.reject(new Error("No trusted source may reach Core")) },
              BROWSER_ORIGIN: context.headers.origin ?? "",
              LOCAL_CANONICAL_READ_BEARER: "",
              PAT_ADMISSION_KEY: "key-long-enough-for-this-workerd-fixture",
            }
          )
        );

        expect(missing.status).toBe(503);
        yield* native(() => missing.arrayBuffer());
      })
  );
});
