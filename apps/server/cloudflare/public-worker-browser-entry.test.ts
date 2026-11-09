import { browserSessionBindingHeader } from "~/shell/browser-transport/contract";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import publicWorker from "./public-worker";
import { erasureRegistryName } from "./erasure/contract";

it.effect.each([false, true])(
  "preserves the initial-context query, browser Origin and cookie through the public gateway",
  (independent) =>
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
      const core = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
      const target = vi.fn(
        (name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
          expect(name).toBe(erasureRegistryName);
          expect(options?.locationHint).toBe("enam");
          return { fetch: forward };
        }
      );
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
            CORE: { fetch: independent ? core : forward },
            ...(independent ? { ERASURE_REGISTRY_COORDINATOR: { getByName: target } } : {}),
          }
        )
      );
      expect(response.status).toBe(200);
      expect(forward).toHaveBeenCalledTimes(1);
      expect(core).not.toHaveBeenCalled();
      expect(target).toHaveBeenCalledTimes(independent ? 1 : 0);
    })
);

it.effect("rejects an unapproved browser Origin before selecting the metadata read executor", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(() => Promise.resolve(new Response()));
    const getByName = vi.fn(() => ({ fetch }));
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
          ERASURE_REGISTRY_COORDINATOR: { getByName },
        }
      )
    );
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(getByName).not.toHaveBeenCalled();
  })
);
