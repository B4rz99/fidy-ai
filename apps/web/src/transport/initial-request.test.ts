import { afterEach, expect, it, vi } from "vitest";
import { Effect, Exit, Option } from "effect";
import { beginInitialBrowserRequest, initialRequestFetch } from "./initial-request";
import { loadBrowserSessionEntry } from "./session-binding";

afterEach(() => vi.unstubAllGlobals());
const origin = "https://api.test.fidyapp.com";
it("starts immediately with bounded, credentialed transport and hands the response off exactly once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const first = Response.json({ binding: null });
      const second = Response.json({ binding: null });
      const network = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(first)
        .mockResolvedValue(second);
      vi.stubGlobal("fetch", network);
      const request = beginInitialBrowserRequest({
        apiOrigin: origin,
        context: false,
        transactions: false,
      });
      expect(network).toHaveBeenCalledTimes(1);
      const options = network.mock.calls[0]?.[1];
      expect(options).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
      expect(options?.signal?.aborted).toBe(false);
      const transport = initialRequestFetch(request);
      expect(yield* Effect.tryPromise(() => transport(request.url))).toBe(first);
      expect(network).toHaveBeenCalledTimes(1);
      expect(yield* Effect.tryPromise(() => transport(request.url))).toBe(second);
      expect(network).toHaveBeenCalledTimes(2);
      request.cancel();
      expect(options?.signal?.aborted).toBe(true);
    })
  ));
it("does not consume prepared session context for a different URL", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const first = Response.json({ binding: null });
      const other = Response.json({ status: "Missing", withdrawal: null });
      const network = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(first)
        .mockResolvedValue(other);
      vi.stubGlobal("fetch", network);
      const request = beginInitialBrowserRequest({
        apiOrigin: origin,
        context: false,
        transactions: false,
      });
      const transport = initialRequestFetch(request);
      expect(yield* Effect.tryPromise(() => transport(`${origin}/web/consent`))).toBe(other);
      expect(yield* Effect.tryPromise(() => transport(request.url))).toBe(first);
      expect(network).toHaveBeenCalledTimes(2);
      request.cancel();
    })
  ));
it("still rejects malformed prepared responses through the ordinary declared response codec", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = vi.fn().mockResolvedValue(Response.json({ binding: "not-a-WebSession-id" }));
      vi.stubGlobal("fetch", network);
      const request = beginInitialBrowserRequest({
        apiOrigin: origin,
        context: false,
        transactions: false,
      });
      const result = yield* Effect.exit(
        loadBrowserSessionEntry({
          apiOrigin: origin,
          context: false,
          request: Option.some(request),
        })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(network).toHaveBeenCalledTimes(1);
      request.cancel();
    })
  ));
