import { it } from "@effect/vitest";
import { Effect } from "effect";
import { Miniflare } from "miniflare";
import { expect } from "vitest";
import { statementParserLimits } from "../../src/shell/ingestion/contract";

const buildParser = (): Promise<string> =>
  Bun.build({
    entrypoints: [new URL("./document-parsing-worker.ts", import.meta.url).pathname],
    target: "browser",
  }).then((built) => {
    const output = built.outputs[0];
    if (!built.success || output === undefined) throw new Error("Parser bundle failed");
    return output.text();
  });

const parserRuntime = (module: string): Miniflare =>
  new Miniflare({
    workers: [
      {
        config: {
          name: "statement-parser-limits",
          type: "worker",
          compatibilityDate: "2026-09-08",
          manifest: {
            mainModule: "index.mjs",
            modules: { "index.mjs": { contents: module, type: "esm" } },
          },
        },
      },
    ],
  });

it.live("rejects empty-field amplification in workerd and continues serving valid statements", () =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise(buildParser);
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => parserRuntime(module)),
      (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
    );
    for (const delimiter of [",", ";", "\t"]) {
      const response = yield* Effect.tryPromise(() =>
        runtime.dispatchFetch("https://parser.internal/statement", {
          method: "POST",
          body: delimiter.repeat(statementParserLimits.maximumDecodedBytes),
        })
      );
      expect(response.status).toBe(413);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        outcome: "rejected",
        reason: "resource-limit",
      });
    }
    const response = yield* Effect.tryPromise(() =>
      runtime.dispatchFetch("https://parser.internal/statement", {
        method: "POST",
        body: 'Date,Description\n2026-01-01,"a,b\nwith ""quotes"""',
      })
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
      outcome: "parsed",
      format: "csv",
      rowCount: 1,
    });
  })
);

it.live(
  "rejects shared-string amplification in workerd and still accepts bounded XLSX evidence",
  () =>
    Effect.gen(function* () {
      const module = yield* Effect.tryPromise(buildParser);
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => parserRuntime(module)),
        (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
      );
      for (const [fixture, status] of [
        ["shared-string-total-limit", 413],
        ["shared-string-small", 200],
        ["shared-string-row-limit", 200],
      ] as const) {
        const source = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL(`../../src/shell/ingestion/internal/fixtures/${fixture}.xlsx`, import.meta.url)
          ).bytes()
        );
        const response = yield* Effect.tryPromise(() =>
          runtime.dispatchFetch("https://parser.internal/statement", {
            method: "POST",
            body: source,
          })
        );
        expect(response.status).toBe(status);
      }
    })
);
