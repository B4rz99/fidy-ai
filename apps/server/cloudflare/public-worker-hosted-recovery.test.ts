import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import publicWorker from "./public-worker";

const origin = "https://app.fidyapp.com";
const path = "/web/hosted-turns/progress";
const environment = (
  fetch: Parameters<typeof publicWorker.fetch>[1]["CORE"]["fetch"]
): Parameters<typeof publicWorker.fetch>[1] => ({
  BROWSER_ORIGIN: origin,
  LOCAL_CANONICAL_READ_BEARER: "",
  PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  CORE: { fetch },
});

for (const route of ["/web/hosted-turns", path, "/web/hosted-turns/delivery"]) {
  it.effect(`admits browser POST preflight for ${route}`, () =>
    Effect.gen(function* () {
      const fetch = vi.fn(() => Promise.resolve(new Response()));
      const response = yield* Effect.tryPromise(() =>
        publicWorker.fetch(
          new Request(`https://api.fidyapp.com${route}`, {
            method: "OPTIONS",
            headers: {
              origin,
              "access-control-request-method": "POST",
              "access-control-request-headers": "content-type,fidy-session-binding",
            },
          }),
          environment(fetch)
        )
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-allow-methods")).toBe("POST");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(fetch).not.toHaveBeenCalled();
    })
  );
}

it.effect("forwards retained-Turn recovery with browser credentials and the original body", () =>
  Effect.gen(function* () {
    const body = '{"turnId":"00000000-0000-4000-8000-000000000001"}';
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const forwarded = new Request(input);
      expect(new URL(forwarded.url).pathname).toBe(path);
      expect(forwarded.method).toBe("POST");
      expect(forwarded.headers.get("cookie")).toBe("session=test-only-cookie");
      expect(forwarded.headers.get("fidy-session-binding")).toBe("test-only-binding");
      expect(forwarded.headers.has("authorization")).toBe(false);
      return forwarded.text().then((actual) => {
        expect(actual).toBe(body);
        return Response.json({ status: "processing" }, { status: 202 });
      });
    });
    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(
        new Request(`https://api.fidyapp.com${path}`, {
          method: "POST",
          headers: {
            origin,
            cookie: "session=test-only-cookie",
            "content-type": "application/json",
            "fidy-session-binding": "test-only-binding",
          },
          body,
        }),
        environment(fetch)
      )
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetch).toHaveBeenCalledOnce();
  })
);

for (const requestOrigin of [undefined, "https://untrusted.example"]) {
  it.effect(`refuses recovery without the configured browser origin (${requestOrigin})`, () =>
    Effect.gen(function* () {
      const fetch = vi.fn(() => Promise.resolve(new Response()));
      const headers = new Headers({ cookie: "session=test-only-cookie" });
      if (requestOrigin !== undefined) headers.set("origin", requestOrigin);
      const response = yield* Effect.tryPromise(() =>
        publicWorker.fetch(
          new Request(`https://api.fidyapp.com${path}`, { method: "POST", headers }),
          environment(fetch)
        )
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    })
  );
}

it.effect("refuses unsupported recovery methods before forwarding", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(() => Promise.resolve(new Response()));
    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(
        new Request(`https://api.fidyapp.com${path}`, { headers: { origin } }),
        environment(fetch)
      )
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(fetch).not.toHaveBeenCalled();
  })
);
