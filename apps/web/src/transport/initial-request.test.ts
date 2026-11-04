import { captureInitialDashboardHtml, takeInitialDashboardHtml } from "./initial-dashboard";
import { afterEach, expect, it, vi } from "vitest";
import { Effect, Exit, Option, Schema } from "effect";
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

it("consumes the audited document bootstrap once without another HTTP binding or context request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const binding = "10000000-0000-4000-8000-000000000061";
      const network = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ binding: null }));
      vi.stubGlobal("fetch", network);
      vi.stubGlobal("document", {
        getElementById: (id: string) =>
          id === "dashboard-bootstrap"
            ? {
                remove: (): void => undefined,
                textContent: Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json))({
                  binding,
                  initial: { status: "Missing", withdrawal: null },
                }),
              }
            : { dataset: { binding, status: "200" }, innerHTML: "<main>native view</main>" },
      });
      captureInitialDashboardHtml();
      const request = beginInitialBrowserRequest({
        apiOrigin: origin,
        context: true,
        transactions: false,
      });
      const result = yield* loadBrowserSessionEntry({
        apiOrigin: origin,
        context: true,
        request: Option.some(request),
      });
      expect(result).toMatchObject({
        binding,
        initial: Option.some({ status: "Missing", withdrawal: null }),
      });
      expect(network).toHaveBeenCalledTimes(0);
      expect(takeInitialDashboardHtml(binding)).toEqual(
        Option.some({ binding, status: 200, html: "<main>native view</main>" })
      );
      request.cancel();
      beginInitialBrowserRequest({
        apiOrigin: origin,
        context: false,
        transactions: false,
      }).cancel();
      expect(network).toHaveBeenCalledTimes(1);
    })
  ));
