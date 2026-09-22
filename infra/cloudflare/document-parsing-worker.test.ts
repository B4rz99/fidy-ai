// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { statementParserLimits } from "@fidy/server/statement-parser";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, vi } from "vitest";
import documentParsingWorker from "./document-parsing-worker";

const parse = (body: BodyInit, headers?: HeadersInit, signal?: AbortSignal): Promise<Response> =>
  documentParsingWorker.fetch(
    new Request("https://document-parser.internal/statement", {
      body,
      headers,
      method: "POST",
      signal,
    })
  );

describe("Document parsing Worker proof", () => {
  it.effect("sniffs CSV bytes instead of trusting a mismatched type claim", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        parse("Date,Amount\n2026-01-01,1000", { "content-type": "application/pdf" })
      );

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        format: "csv",
        outcome: "parsed",
        rowCount: 1,
      });
    })
  );

  it.effect("parses the representative XLSX fixture without evaluating active content", () =>
    Effect.gen(function* () {
      const outboundFetch = vi.spyOn(globalThis, "fetch");
      const bytes = yield* Effect.promise(() =>
        readFile(
          new URL(
            "../../apps/server/src/shell/ingestion/fixtures/synthetic-statement.xlsx",
            import.meta.url
          )
        )
      );
      const response = yield* Effect.promise(() => parse(bytes));

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        format: "xlsx",
        outcome: "parsed",
        rowCount: 2,
      });
      expect(outboundFetch).not.toHaveBeenCalled();
      outboundFetch.mockRestore();
    })
  );

  it.effect("rejects a genuinely encrypted PDF instead of interpreting it as CSV", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() =>
        readFile(new URL("./fixtures/protected-document.pdf", import.meta.url))
      );
      const response = yield* Effect.promise(() => parse(bytes));

      expect(response.status).toBe(422);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        outcome: "rejected",
        reason: "unsupported-format",
      });
    })
  );

  it.effect("rejects image bytes instead of interpreting them as CSV", () =>
    Effect.gen(function* () {
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
      const response = yield* Effect.promise(() => parse(bytes));

      expect(response.status).toBe(422);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        outcome: "rejected",
        reason: "unsupported-format",
      });
    })
  );

  it.effect("rejects an oversized declared body before reading it", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        parse("not read", {
          "content-length": String(statementParserLimits.maximumDecodedBytes + 1),
        })
      );

      expect(response.status).toBe(413);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        outcome: "rejected",
        reason: "resource-limit",
      });
    })
  );

  it.effect("cancels an oversized stream immediately after it crosses the byte ceiling", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const chunk = new Uint8Array(statementParserLimits.maximumDecodedBytes / 5);
      let emittedChunks = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel: (): void => {
          cancelled = true;
        },
        pull: (controller): void => {
          emittedChunks += 1;
          controller.enqueue(chunk);
        },
      });

      const response = yield* Effect.promise(() => parse(body));

      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(emittedChunks).toBeLessThanOrEqual(7);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        outcome: "rejected",
        reason: "resource-limit",
      });
    })
  );

  it.effect("interrupts body collection when the request is cancelled in flight", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line abortControllerInEffect:off -- the HTTP signal is the seam under test.
      const abort = new AbortController();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel: (): void => {
          cancelled = true;
        },
        pull: (controller): void => {
          controller.enqueue(new TextEncoder().encode("Date,Amount\n"));
          abort.abort();
        },
      });
      const response = yield* Effect.promise(() => parse(body, {}, abort.signal));

      expect(response.status).toBe(499);
      expect(cancelled).toBe(true);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        outcome: "rejected",
        reason: "cancelled",
      });
    })
  );
});
