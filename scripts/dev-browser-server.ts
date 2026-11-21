import { fileURLToPath } from "node:url";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit } from "effect";
import { createServer } from "vite";

class ApiProcessFailure extends Data.TaggedError("ApiProcessFailure") {}

class BrowserServerFailure extends Data.TaggedError("BrowserServerFailure")<{
  readonly cause: unknown;
}> {}

const root = fileURLToPath(new URL("../", import.meta.url));

const directory = fileURLToPath(new URL("../.local/browser/", import.meta.url));

const certificate = `${directory}cert.pem`;

const key = `${directory}key.pem`;

const server = await createServer({
  root: `${root}apps/web`,
  define: { "import.meta.env.VITE_API_ORIGIN": JSON.stringify("https://127.0.0.1:4174") },
  configFile: `${root}apps/web/vite.config.ts`,
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    https: { key: await Bun.file(key).text(), cert: await Bun.file(certificate).text() },
  },
});

const api = Bun.spawn([process.execPath, "scripts/dev-browser-api.ts"], {
  cwd: root,
  env: {
    ...Bun.env,
    PLAYWRIGHT_TLS_CERT: certificate,
    PLAYWRIGHT_TLS_KEY: key,
  },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});

const serve = Effect.gen(function* () {
  yield* Effect.tryPromise({
    try: () => server.listen(),
    catch: (cause) => new BrowserServerFailure({ cause }),
  });
  server.printUrls();

  return yield* Effect.tryPromise({
    try: () => api.exited,
    catch: () => new ApiProcessFailure(),
  }).pipe(Effect.as(1));
}).pipe(
  Effect.ensuring(
    Effect.tryPromise({
      try: () => server.close(),
      catch: (cause) => new BrowserServerFailure({ cause }),
    }).pipe(
      Effect.andThen(Effect.sync(() => api.kill())),
      Effect.andThen(
        Effect.tryPromise({
          try: () => api.exited,
          catch: (cause) => new BrowserServerFailure({ cause }),
        })
      ),
      Effect.orDie
    )
  )
);

BunRuntime.runMain(
  serve.pipe(
    Effect.tap((code) =>
      Effect.sync(() => {
        process.exitCode = code;
      })
    )
  ),
  {
    teardown: (exit, onExit) =>
      onExit(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? 1 : 0),
  }
);
