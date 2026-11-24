import { browserSessionBindingHeader } from "~/shell/browser-transport/contract";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import publicWorker from "./public-worker";

it.effect(
  "preserves the initial-context query, browser Origin and cookie through the public gateway",
  () =>
    Effect.gen(function* () {
      const cookie = `__Host-fidy_session=${"d".repeat(43)}`;
      const origin = "https://app.fidyapp.com";

      const forward = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(new URL(request.url).search).toBe("?context=application");
        expect(request.headers.get("origin")).toBe(origin);
        expect(request.headers.get("cookie")).toBe(cookie);
        expect(request.headers.get(browserSessionBindingHeader)).toBe("current-binding");
        expect(request.headers.has("authorization")).toBe(false);

        return Promise.resolve(Response.json({ binding: null }));
      });

      const response = yield* Effect.tryPromise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/web/session/binding?context=application", {
            headers: {
              origin,
              cookie,
              authorization: "Bearer untrusted",
              [browserSessionBindingHeader]: "current-binding",
            },
          }),
          {
            BROWSER_ORIGIN: origin,
            LOCAL_CANONICAL_READ_BEARER: "",
            PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
            RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
            CORE: { fetch: forward },
          }
        )
      );

      expect(response.status).toBe(200);
      expect(forward).toHaveBeenCalledTimes(1);
    })
);

it.effect("rejects an unapproved browser Origin before forwarding to Core", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(() => Promise.resolve(new Response()));

    const response = yield* Effect.tryPromise(() =>
      publicWorker.fetch(
        new Request("https://api.fidyapp.com/web/session/binding?context=application", {
          headers: {
            origin: "https://unapproved.example",
            cookie: `__Host-fidy_session=${"d".repeat(43)}`,
          },
        }),
        {
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          LOCAL_CANONICAL_READ_BEARER: "",
          PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
          RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          CORE: { fetch },
        }
      )
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  })
);

it.effect("allows the matching browser preflight and refuses another browser", () =>
  Effect.gen(function* () {
    const browser = "https://app.fidyapp.com";
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

    const environment = {
      BROWSER_ORIGIN: browser,
      LOCAL_CANONICAL_READ_BEARER: "",
      PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
      RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
      CORE: { fetch },
    };

    yield* Effect.forEach(
      [browser, "https://other.fidyapp.com"],
      Effect.fnUntraced(function* (origin) {
        const result = yield* Effect.tryPromise(() =>
          publicWorker.fetch(
            new Request("https://api.fidyapp.com/transactions", {
              method: "OPTIONS",
              headers: { origin, "access-control-request-method": "GET" },
            }),
            environment
          )
        );

        expect(result.status).toBe(origin === browser ? 204 : 403);
        expect(result.headers.get("access-control-allow-origin")).toBe(
          origin === browser ? browser : null
        );
      }),
      { discard: true }
    );

    expect(fetch).not.toHaveBeenCalled();
  })
);
