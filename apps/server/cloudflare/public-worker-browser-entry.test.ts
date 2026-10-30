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
