import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkBrowserBundle } from "./check-browser-bundle";

const webRoot = process.cwd();
const workspaceRoot = join(webRoot, "..", "..");

it("rejects a forbidden runtime dependency reachable from the web entrypoint", async () => {
  const fixtureRoot = await mkdtemp(join(webRoot, ".bundle-test-"));
  try {
    await mkdir(join(fixtureRoot, "src/features/home"), { recursive: true });
    await Bun.write(
      join(fixtureRoot, "src/main.tsx"),
      'import { HomeFeature } from "@/features/home/feature";\n\nexport const Root = HomeFeature;\n'
    );
    await Bun.write(
      join(fixtureRoot, "src/features/home/feature.tsx"),
      'import { BunRuntime } from "@effect/platform-bun";\n\nexport const HomeFeature = BunRuntime;\n'
    );

    await expect(
      checkBrowserBundle({
        entrypoint: "src/main.tsx",
        outdir: join(fixtureRoot, "bundle"),
        webRoot: fixtureRoot,
        workspaceRoot,
      })
    ).rejects.toThrow(/Browser-incompatible runtime modules[\s\S]*@effect\/platform-bun/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
