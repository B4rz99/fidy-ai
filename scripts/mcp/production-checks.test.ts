import { expect, it } from "vitest";
import { Effect, FileSystem, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { tmpdir } from "node:os";
import { privateDirectory } from "./production-fixture";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it("uses one canonical private directory for native profile identity and cleans it on scope exit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* Effect.scoped(
        Effect.gen(function* () {
          const root = yield* privateDirectory;
          expect(root).toBe(yield* fs.realPath(root));
          expect(yield* fs.exists(root)).toBe(true);
          return root;
        })
      );
      expect(yield* fs.exists(root)).toBe(false);
    }).pipe(Effect.provide(BunFileSystem.layer))
  ));
it("refuses Production work without explicit synthetic authorization before invoking clients", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          directory: tmpdir(),
          prefix: "fidy-mcp-production-gate-",
        });
        const scope = `${root}/scope.json`;
        yield* fs.writeFileString(scope, encode({ approved: false }));
        const result = Bun.spawnSync(
          ["bun", "scripts/mcp/production-checks.ts", "--scope", scope, "--validate-only"],
          { stdout: "pipe", stderr: "pipe" }
        );
        expect(result.exitCode).toBe(1);
        expect(new TextDecoder().decode(result.stderr)).toContain(
          "Explicit synthetic authorization required"
        );
        expect(new TextDecoder().decode(result.stdout)).not.toContain("passed");
      })
    ).pipe(Effect.provide(BunFileSystem.layer))
  ));

it("rejects a stale approved scope without performing Production checks", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          directory: tmpdir(),
          prefix: "fidy-mcp-production-gate-",
        });
        const scope = `${root}/scope.json`;
        yield* fs.writeFileString(
          scope,
          encode({
            approved: true,
            authorization: "synthetic MCP verification",
            approvedAt: "2000-01-01T00:00:00.000Z",
            namespace: "test-proof",
            fixtureUserId: "99000000-2026-4000-8000-000000000001",
            portfolio: "issue-990-synthetic",
            accountId: "a32350b6918ad7e78bc589b6630af1c2",
            databaseId: "2622d5b0-5e0f-4766-b836-ff0f635a92a6",
            revision: "63494fd4f7a915005a8f750547f4bb3548835e90",
            coreVersion: "2ef8ed24-1a98-4bcc-a083-533c433a803b",
            ingressVersion: "41ce2bf1-22e3-410f-926c-24fb2d65323f",
            workers: { core: "fixture-core", ingress: "fixture-ingress" },
            binaries: { claude: "/nonexistent/claude", codex: "/nonexistent/codex" },
            windowMinutes: 30,
            maximumRequests: 100,
          })
        );
        const result = Bun.spawnSync(
          ["bun", "scripts/mcp/production-checks.ts", "--scope", scope, "--validate-only"],
          { stdout: "pipe", stderr: "pipe" }
        );
        expect(result.exitCode).toBe(1);
        expect(new TextDecoder().decode(result.stderr)).toContain(
          "Synthetic approval is stale or in the future"
        );
      })
    ).pipe(Effect.provide(BunFileSystem.layer))
  ));
