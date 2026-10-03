import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "@effect/vitest";
import { checkBrowserBundle } from "./check-browser-bundle";

const webRoot = process.cwd();
const workspaceRoot = join(webRoot, "..", "..");

it.effect("rejects a forbidden runtime dependency reachable from the web entrypoint", () =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => mkdtemp(join(webRoot, ".bundle-test-"))),
    (fixtureRoot) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          mkdir(join(fixtureRoot, "src/features/public-site"), { recursive: true })
        );
        yield* Effect.tryPromise(() =>
          Bun.write(
            join(fixtureRoot, "src/main.tsx"),
            'import { PublicSiteFeature } from "@/features/public-site/feature";\n\nexport const Root = PublicSiteFeature;\n'
          )
        );
        yield* Effect.tryPromise(() =>
          Bun.write(
            join(fixtureRoot, "src/features/public-site/feature.tsx"),
            'import { readFileSync } from "node:fs";\n\nexport const PublicSiteFeature = readFileSync;\n'
          )
        );
        yield* Effect.tryPromise(() =>
          expect(
            checkBrowserBundle({
              entrypoint: "src/main.tsx",
              outdir: join(fixtureRoot, "bundle"),
              webRoot: fixtureRoot,
              workspaceRoot,
            })
          ).rejects.toThrow(/Browser-incompatible runtime modules[\s\S]*node:fs/u)
        );
      }),
    (fixtureRoot) => Effect.tryPromise(() => rm(fixtureRoot, { recursive: true, force: true }))
  )
);

it.effect.each([
  { name: "private native types", nativePath: "runtime/release-smoke/internal/protocol" },
  { name: "published native contracts", nativePath: "runtime/release-smoke/contract" },
])("rejects $name imported only as browser transport types", ({ nativePath }) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => mkdtemp(join(webRoot, ".bundle-test-"))),
    (fixtureRoot) =>
      Effect.gen(function* () {
        const fixtureWebRoot = join(fixtureRoot, "apps/web");
        const importPath = `../../../server/cloudflare/${nativePath}`;
        yield* Effect.tryPromise(() =>
          Bun.write(
            join(fixtureWebRoot, "src/main.tsx"),
            'export type { NativeTransport } from "./transport/native";\nexport const Root = true;\n'
          )
        );
        yield* Effect.tryPromise(() =>
          Bun.write(
            join(fixtureWebRoot, "src/transport/native.ts"),
            `import type { NativeProof } from "${importPath}";\nexport type NativeTransport = NativeProof;\n`
          )
        );
        yield* Effect.tryPromise(() =>
          Bun.write(
            join(fixtureRoot, `apps/server/cloudflare/${nativePath}.ts`),
            "export type NativeProof = { readonly protocolVersion: 1 };\n"
          )
        );
        yield* Effect.tryPromise(() =>
          expect(
            checkBrowserBundle({
              entrypoint: "src/main.tsx",
              outdir: join(fixtureRoot, "bundle"),
              webRoot: fixtureWebRoot,
              workspaceRoot: fixtureRoot,
            })
          ).rejects.toThrow(
            `src/transport/native.ts imports server code outside the canonical transport seam: ${importPath}`
          )
        );
      }),
    (fixtureRoot) => Effect.tryPromise(() => rm(fixtureRoot, { recursive: true, force: true }))
  )
);
