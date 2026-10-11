import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import publicWorker from "./public-worker";

const environment: Parameters<typeof publicWorker.fetch>[1] = {
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  LOCAL_CANONICAL_READ_BEARER: "",
  PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  CORE: { fetch: () => Promise.reject(new Error("Manifest must not access Core")) },
};
afterEach(() => vi.unstubAllGlobals());

it.effect("publishes the latest released CLI version anonymously as plain text", () =>
  Effect.gen(function* () {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("0.1.2\n")));
    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(new Request("https://api.fidyapp.com/cli/latest.txt"), environment)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(yield* Effect.tryPromise(() => response.text())).toBe("0.1.2\n");
  })
);

for (const [name, status, body] of [
  ["missing release", 404, "not found"],
  ["upstream failure", 500, "0.1.2\n"],
  ["malformed version", 200, "<html>application</html>"],
  ["oversized version", 200, "1".repeat(65)],
  ["provider body overflow", 200, "1".repeat(4097)],
] as const) {
  it.effect(`rejects ${name} without publishing a default version`, () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status })));
      const response = yield* Effect.tryPromise(() =>
        publicWorker.fetch(new Request("https://api.fidyapp.com/cli/latest.txt"), environment)
      );
      expect(response.status).toBe(503);
      expect(yield* Effect.tryPromise(() => response.text())).toBe("CLI release unavailable.\n");
    })
  );
}

it.effect("rejects a write to the release pointer without contacting the upstream", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(() => Promise.resolve(new Response("0.1.2\n")));
    vi.stubGlobal("fetch", fetch);
    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(
        new Request("https://api.fidyapp.com/cli/latest.txt", { method: "POST" }),
        environment
      )
    );
    expect(response.status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  })
);

const holdManifest = (signal: AbortSignal): Promise<Response> =>
  Effect.runPromise(Effect.never, { signal });

it.effect("cancels the upstream manifest read when the public request is cancelled", () => {
  const controller = new AbortController();
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    let upstreamSignal = Option.none<AbortSignal>();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      upstreamSignal = Option.fromNullishOr(init.signal);
      Deferred.doneUnsafe(ready, Effect.void);
      return holdManifest(Option.getOrThrow(upstreamSignal));
    });
    const request = new Request("https://api.fidyapp.com/cli/latest.txt", {
      signal: controller.signal,
    });
    const fiber = yield* Effect.tryPromise(() => publicWorker.fetch(request, environment)).pipe(
      Effect.exit,
      Effect.forkScoped
    );
    yield* Deferred.await(ready);
    controller.abort();
    expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
    expect(Option.getOrThrow(upstreamSignal).aborted).toBe(true);
  }).pipe(Effect.scoped);
});

it.effect("does not forward caller credentials or destinations to the release host", () =>
  Effect.gen(function* () {
    const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response("0.1.2\n"))
    );
    vi.stubGlobal("fetch", fetch);
    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(
        new Request("https://api.fidyapp.com/cli/latest.txt?url=https://attacker.invalid", {
          headers: {
            authorization: "Bearer private-caller-proof",
            cookie: "private-session-proof",
          },
        }),
        environment
      )
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls.at(0);
    expect(call).toBeDefined();
    expect(call?.[0]).toEqual(
      new URL("https://github.com/B4rz99/fidy-ai/releases/latest/download/latest.txt")
    );
    expect(call?.[1]?.redirect).toBe("manual");
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(call?.[1]?.credentials).toBe("omit");
  })
);

it.effect("follows only the bounded GitHub release asset redirect chain", () =>
  Effect.gen(function* () {
    const asset =
      "https://release-assets.githubusercontent.com/github-production-release-asset/1/latest.txt?signature=private";
    const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: asset } }))
    );
    fetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://github.com/B4rz99/fidy-ai/releases/download/cli-v0.1.2/latest.txt",
          },
        })
      )
    );
    fetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: asset } }))
    );
    fetch.mockImplementationOnce(() => Promise.resolve(new Response("0.1.2\n")));
    vi.stubGlobal("fetch", fetch);
    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(new Request("https://api.fidyapp.com/cli/latest.txt"), environment)
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  })
);

it.effect("refuses an upstream redirect to an unowned host", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/latest.txt" },
        })
      )
    );
    vi.stubGlobal("fetch", fetch);
    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(new Request("https://api.fidyapp.com/cli/latest.txt"), environment)
    );
    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledOnce();
  })
);

it.effect("stops an allowed redirect loop after three upstream requests", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://github.com/B4rz99/fidy-ai/releases/download/cli-v0.1.2/latest.txt",
          },
        })
      )
    );
    vi.stubGlobal("fetch", fetch);
    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(new Request("https://api.fidyapp.com/cli/latest.txt"), environment)
    );
    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(3);
  })
);
