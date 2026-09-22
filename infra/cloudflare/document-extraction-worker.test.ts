// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, vi } from "vitest";
import documentExtractionWorker, { documentExtractionLimits } from "./document-extraction-worker";

const successfulBindings = (
  data: string
): Parameters<typeof documentExtractionWorker.fetch>[1] => ({
  AI: {
    toMarkdown: vi.fn(() => Promise.resolve([{ data, format: "markdown" as const }])),
  },
});

const extract = (
  body: BodyInit,
  bindings: Parameters<typeof documentExtractionWorker.fetch>[1],
  init: Omit<RequestInit, "body" | "method"> = {}
): Promise<Response> =>
  documentExtractionWorker.fetch(
    new Request("https://document-extractor.internal/extract", { ...init, body, method: "POST" }),
    bindings
  );

const responseBody = (response: Response): Promise<unknown> => response.json();
type ToMarkdownResult = Awaited<
  ReturnType<Parameters<typeof documentExtractionWorker.fetch>[1]["AI"]["toMarkdown"]>
>;

const ConvertedResponse = Schema.Struct({
  elapsedMilliseconds: Schema.Finite,
  outcome: Schema.Literal("converted"),
  outputBytes: Schema.Int,
});

describe("Document extraction Worker proof", () => {
  it.effect.each([
    { expectedName: "statement.pdf", fixture: "valid-document.pdf" },
    { expectedName: "statement.png", fixture: "valid-image.png" },
  ])(
    "converts a bounded $expectedName through the Workers AI binding",
    ({ fixture, expectedName }) =>
      Effect.gen(function* () {
        const body = yield* Effect.promise(() =>
          readFile(new URL(`./fixtures/${fixture}`, import.meta.url))
        );
        const bindings = successfulBindings("bounded markdown");
        const response = yield* Effect.promise(() => extract(body, bindings));

        expect(response.status).toBe(200);
        const result = yield* Schema.decodeUnknownEffect(ConvertedResponse)(
          yield* Effect.promise(() => responseBody(response))
        );
        expect(result.outcome).toBe("converted");
        expect(result.outputBytes).toBe(16);
        expect(result.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
        expect(bindings.AI.toMarkdown).toHaveBeenCalledOnce();
        expect(bindings.AI.toMarkdown).toHaveBeenCalledWith([
          expect.objectContaining({ name: expectedName }),
        ]);
      })
  );

  it.effect("selects the converter from bytes rather than a mismatched content-type claim", () =>
    Effect.gen(function* () {
      const body = yield* Effect.promise(() =>
        readFile(new URL("./fixtures/valid-image.png", import.meta.url))
      );
      const bindings = successfulBindings("image");
      const response = yield* Effect.promise(() =>
        extract(body, bindings, { headers: { "content-type": "application/pdf" } })
      );

      expect(response.status).toBe(200);
      expect(bindings.AI.toMarkdown).toHaveBeenCalledWith([
        expect.objectContaining({ name: "statement.png" }),
      ]);
    })
  );

  it.effect.each([
    {
      body: new TextEncoder().encode("not a document"),
      expectedReason: "unsupported-format",
      label: "unknown bytes",
    },
    {
      body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      expectedReason: "malformed-file",
      label: "truncated PNG",
    },
    {
      body: new TextEncoder().encode("%PDF-1.7\nmissing trailer"),
      expectedReason: "malformed-file",
      label: "truncated PDF",
    },
  ])("rejects $label before invoking Workers AI", ({ body, expectedReason }) =>
    Effect.gen(function* () {
      const bindings = successfulBindings("must not run");
      const response = yield* Effect.promise(() => extract(body, bindings));

      expect(response.status).toBe(422);
      expect(yield* Effect.promise(() => responseBody(response))).toEqual({
        outcome: "rejected",
        reason: expectedReason,
      });
      expect(bindings.AI.toMarkdown).not.toHaveBeenCalled();
    })
  );

  it.effect("rejects excessive PNG dimensions before invoking Workers AI", () =>
    Effect.gen(function* () {
      const body = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgD/////AAAAAQ==");
      const bindings = successfulBindings("must not run");
      const response = yield* Effect.promise(() => extract(body, bindings));

      expect(response.status).toBe(413);
      expect(yield* Effect.promise(() => responseBody(response))).toEqual({
        outcome: "rejected",
        reason: "resource-limit",
      });
      expect(bindings.AI.toMarkdown).not.toHaveBeenCalled();
    })
  );

  it.effect("rejects an encrypted PDF for the isolated protected-document path", () =>
    Effect.gen(function* () {
      const body = yield* Effect.promise(() =>
        readFile(new URL("./fixtures/protected-document.pdf", import.meta.url))
      );
      const bindings = successfulBindings("must not run");
      const response = yield* Effect.promise(() => extract(body, bindings));

      expect(response.status).toBe(422);
      expect(yield* Effect.promise(() => responseBody(response))).toEqual({
        outcome: "rejected",
        reason: "password-required",
      });
      expect(bindings.AI.toMarkdown).not.toHaveBeenCalled();
    })
  );

  it.effect("rejects a declared body above the input ceiling before invoking Workers AI", () =>
    Effect.gen(function* () {
      const bindings = successfulBindings("must not run");
      const response = yield* Effect.promise(() =>
        extract("%PDF-1.7\n%%EOF", bindings, {
          headers: { "content-length": String(documentExtractionLimits.maximumInputBytes + 1) },
        })
      );

      expect(response.status).toBe(413);
      expect(bindings.AI.toMarkdown).not.toHaveBeenCalled();
    })
  );

  it.effect("cancels an oversized stream when it crosses the input ceiling", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const chunk = new Uint8Array(documentExtractionLimits.maximumInputBytes / 5);
      const body = new ReadableStream<Uint8Array>({
        cancel: (): void => {
          cancelled = true;
        },
        pull: (controller): void => {
          controller.enqueue(chunk);
        },
      });
      const bindings = successfulBindings("must not run");
      const response = yield* Effect.promise(() => extract(body, bindings));

      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(bindings.AI.toMarkdown).not.toHaveBeenCalled();
    })
  );

  it.effect("rejects converted output above the byte ceiling", () =>
    Effect.gen(function* () {
      const bindings = successfulBindings(
        "x".repeat(documentExtractionLimits.maximumOutputBytes + 1)
      );
      const response = yield* Effect.promise(() => extract("%PDF-1.4\n%%EOF", bindings));

      expect(response.status).toBe(413);
      expect(bindings.AI.toMarkdown).toHaveBeenCalledOnce();
      expect(yield* Effect.promise(() => responseBody(response))).toEqual({
        outcome: "rejected",
        reason: "resource-limit",
      });
    })
  );

  it.effect("returns a closed failure when Workers AI rejects malformed content", () =>
    Effect.gen(function* () {
      const bindings: Parameters<typeof documentExtractionWorker.fetch>[1] = {
        AI: { toMarkdown: vi.fn(() => Promise.reject(new Error("provider details"))) },
      };
      const response = yield* Effect.promise(() => extract("%PDF-1.4\n%%EOF", bindings));

      expect(response.status).toBe(422);
      expect(yield* Effect.promise(() => responseBody(response))).toEqual({
        outcome: "rejected",
        reason: "conversion-failed",
      });
    })
  );

  it.effect("stops awaiting Workers AI when the request is cancelled", () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const conversionStarted = Promise.withResolvers<void>();
      const pendingConversion = Promise.withResolvers<ToMarkdownResult>();
      const bindings: Parameters<typeof documentExtractionWorker.fetch>[1] = {
        AI: {
          toMarkdown: vi.fn(() => {
            conversionStarted.resolve();
            return pendingConversion.promise;
          }),
        },
      };
      const responsePromise = extract("%PDF-1.4\n%%EOF", bindings, {
        signal: controller.signal,
      });
      yield* Effect.promise(() => conversionStarted.promise);
      controller.abort();
      const response = yield* Effect.promise(() => responsePromise);

      expect(response.status).toBe(499);
      expect(yield* Effect.promise(() => responseBody(response))).toEqual({
        outcome: "rejected",
        reason: "cancelled",
      });
    });
  });
});
