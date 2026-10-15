import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
import { createServer } from "vite";

class ApiProcessFailure extends Data.TaggedError("ApiProcessFailure") {}

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
const api = Bun.spawn([process.execPath, "apps/server/cloudflare/browser-acceptance-preview.ts"], {
  cwd: root,
  env: {
    ...Bun.env,
    CLI_ACCEPTANCE_MODE: "shared",
    PLAYWRIGHT_TLS_CERT: certificate,
    PLAYWRIGHT_TLS_KEY: key,
  },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const interrupted = Effect.callback<number>((resume) => {
  const finish = (): void => resume(Effect.succeed(0));
  process.once("SIGTERM", finish);
  process.once("SIGINT", finish);
  return Effect.sync(() => {
    process.removeListener("SIGTERM", finish);
    process.removeListener("SIGINT", finish);
  });
});
try {
  await server.listen();
  server.printUrls();
  process.exitCode = await Effect.runPromise(
    Effect.raceFirst(
      Effect.tryPromise({ try: () => api.exited, catch: () => new ApiProcessFailure() }).pipe(
        Effect.as(1)
      ),
      interrupted
    )
  );
} finally {
  await server.close();
  api.kill();
  await api.exited;
}
