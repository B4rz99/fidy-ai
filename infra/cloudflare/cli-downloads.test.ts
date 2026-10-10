import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vitest";
import { Miniflare } from "miniflare";

const exerciseDownloads = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-cli-downloads-" });
  const staged = Bun.spawnSync([
    "bash",
    "../../scripts/cli-release/stage-installers.sh",
    directory,
  ]);
  expect(staged.exitCode).toBe(0);
  yield* Effect.tryPromise(() =>
    Bun.write(`${directory}/index.html`, "<!doctype html>application shell")
  );
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "cli-downloads",
          type: "worker",
          compatibilityDate: "2026-09-08",
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                type: "esm",
                contents:
                  "export default {fetch() {return new Response('unexpected user worker', {status: 500})}}",
              },
            },
          },
          assets: {
            directory,
            hasUserWorker: false,
            htmlHandling: "none",
            notFoundHandling: "single-page-application",
          },
        },
      },
    ],
  });
  yield* Effect.addFinalizer(() => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie));
  for (const name of ["install.sh", "install.ps1"]) {
    const response = yield* Effect.tryPromise(() =>
      instance.dispatchFetch(`https://app.fidyapp.com/${name}`)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(yield* Effect.tryPromise(() => response.text())).toBe(
      yield* Effect.tryPromise(() => Bun.file(`../../scripts/cli-release/${name}`).text())
    );
  }
}, Effect.scoped);

layer(BunFileSystem.layer)((it) => {
  it.effect(
    "serves install scripts as downloads rather than the application shell",
    exerciseDownloads
  );
});
