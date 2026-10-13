import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import publicWorker from "./public-worker";

const environment = (
  fetch: Parameters<typeof publicWorker.fetch>[1]["CORE"]["fetch"],
  browserOrigin = "https://app.fidyapp.com"
): Parameters<typeof publicWorker.fetch>[1] => ({
  BROWSER_ORIGIN: browserOrigin,
  LOCAL_CANONICAL_READ_BEARER: "",
  PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  CORE: { fetch },
});

it.each([
  { url: "https://attacker.example/mcp", headers: {} },
  { url: "https://api.fidyapp.com.attacker.example/mcp", headers: {} },
  { url: "http://api.fidyapp.com/mcp", headers: {} },
  { url: "https://api.fidyapp.com:444/mcp", headers: {} },
  { url: "http://127.0.0.1:8787/mcp", headers: {} },
  { url: "https://api.fidyapp.com/mcp", headers: { host: "attacker.example" } },
  { url: "https://api.fidyapp.com/mcp", headers: { origin: "https://app.fidyapp.com" } },
  { url: "https://api.fidyapp.com/mcp", headers: { origin: "https://attacker.example" } },
  { url: "https://api.fidyapp.com/mcp", headers: { origin: "null" } },
  { url: "https://api.fidyapp.com/mcp", headers: { origin: "" } },
])("rejects invalid MCP transport coordinates before Core admission: $url $headers", (input) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
      const headers = new Headers({ "cf-connecting-ip": "192.0.2.35" });
      for (const [name, value] of Object.entries(input.headers)) headers.set(name, value);
      const response = yield* Effect.tryPromise(() =>
        publicWorker.fetch(new Request(input.url, { headers }), environment(fetch))
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(fetch).not.toHaveBeenCalled();
    })
  )
);

it.each([
  { url: "https://api.fidyapp.com/mcp", browserOrigin: "https://app.fidyapp.com" },
  { url: "http://127.0.0.1:8787/mcp", browserOrigin: "http://127.0.0.1:5173" },
  { url: "https://127.0.0.1:4174/mcp", browserOrigin: "https://127.0.0.1:4173" },
])("preserves Origin-less MCP authentication at the configured API: $url", (input) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));
      const response = yield* Effect.tryPromise(() =>
        publicWorker.fetch(
          new Request(input.url, {
            headers: { host: new URL(input.url).host, "cf-connecting-ip": "192.0.2.35" },
          }),
          environment(fetch, input.browserOrigin)
        )
      );
      expect(response.status).toBe(401);
      expect(fetch).toHaveBeenCalledOnce();
    })
  )
);
