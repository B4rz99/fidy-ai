import { expect, it } from "vitest";
import { Effect, FileSystem, Result } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { encodeJson, privateDirectory } from "./production-fixture";
import { validateCatalog } from "./production-catalog";

it("accepts Codex's nameless built-in web search but still rejects an absent Fidy namespace", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* privateDirectory;
        yield* fs.writeFileString(
          `${root}/codex-catalog-private.json`,
          encodeJson([{ type: "web_search" }])
        );
        const result = yield* Effect.result(validateCatalog(root, "codex"));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toBe(
            "Native restricted catalog did not match the permission contract"
          );
        }
      })
    ).pipe(Effect.provide(BunFileSystem.layer))
  ));

it("rejects an unrecognized nameless catalog entry instead of silently ignoring it", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* privateDirectory;
        yield* fs.writeFileString(
          `${root}/codex-catalog-private.json`,
          encodeJson([{ type: "unknown" }])
        );
        const result = yield* Effect.result(validateCatalog(root, "codex"));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toBe("Invalid verification state");
        }
      })
    ).pipe(Effect.provide(BunFileSystem.layer))
  ));
