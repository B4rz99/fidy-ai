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
