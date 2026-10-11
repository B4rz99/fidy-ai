import { it } from "@effect/vitest";
import { Effect } from "effect";
import { Miniflare } from "miniflare";
import { expect } from "vitest";

const buildProof = (): Promise<string> =>
  Bun.build({
    entrypoints: [new URL("./durable-parser-proof-worker.ts", import.meta.url).pathname],
    target: "browser",
  }).then((built) => {
    const output = built.outputs[0];
    if (!built.success || output === undefined) throw new Error("Durable parser bundle failed");
    return output.text();
  });

it.live(
  "authenticates synthetic parser work before forwarding to a real SQLite Durable Object",
  () =>
    Effect.gen(function* () {
      const module = yield* Effect.tryPromise(buildProof);
      const name = "durable-parser-proof";
      const key = "synthetic-proof-key";
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Miniflare({
              workers: [
                {
                  config: {
                    name,
                    type: "worker",
                    compatibilityDate: "2026-09-08",
                    exports: { XlsxParserProof: { type: "durable-object", storage: "sqlite" } },
                    env: {
                      PARSER_PROOF: {
                        type: "durable-object",
                        worker: name,
                        exportName: "XlsxParserProof",
                      },
                      XLSX_PROOF_KEY: { type: "text", value: key },
                    },
                    manifest: {
                      mainModule: "index.mjs",
                      modules: { "index.mjs": { contents: module, type: "esm" } },
                    },
                  },
                },
              ],
            })
        ),
        (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
      );
      const send = (proofKey: string, body: string): ReturnType<Miniflare["dispatchFetch"]> =>
        runtime.dispatchFetch("https://durable-parser.internal/statement", {
          method: "POST",
          headers: { "X-Xlsx-Proof-Key": proofKey },
          body,
        });
      const refused = yield* Effect.tryPromise(() => send("wrong", "Date,Amount\n2026-01-01,1"));
      expect(refused.status).toBe(404);
      const malformed = yield* Effect.tryPromise(() => send(key, ""));
      expect(malformed.status).toBe(422);
      expect(yield* Effect.tryPromise(() => malformed.json())).toEqual({
        outcome: "rejected",
        reason: "malformed-file",
      });
      const replies = yield* Effect.tryPromise(() =>
        Promise.all([
          send(key, "Date,Amount\n2026-01-01,1"),
          send(key, "Date,Amount\n2026-01-01,1\n2026-01-02,2"),
        ])
      );
      for (const [index, reply] of replies.entries()) {
        expect(reply.status).toBe(200);
        const value = yield* Effect.tryPromise(() => reply.json());
        expect(value).toMatchObject({ outcome: "parsed", format: "csv", rowCount: index + 1 });
      }
    })
);
