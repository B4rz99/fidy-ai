import { BunFileSystem } from "@effect/platform-bun";
import { Clock, Config, Data, Effect, FileSystem } from "effect";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

class CertificateProcessFailure extends Data.TaggedError("CertificateProcessFailure") {}

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const directory = `${root}/.local/browser`;
const certificate = `${directory}/cert.pem`;
const key = `${directory}/key.pem`;
const labelLength = 12;
const startupMilliseconds = 60_000;
const pollMilliseconds = 250;
const privateFileMode = 0o600;
const appPort = 4173;
const apiPort = 4174;
const operatorPort = 4175;
const print = (message: string): void => {
  process.stdout.write(`${message}\n`);
};
const label = `com.fidy.browser.${new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, labelLength)}`;
const target = `gui/${process.getuid?.()}/${label}`;
const plist = `${homedir()}/Library/LaunchAgents/${label}.plist`;
const app = "https://127.0.0.1:4173";
const api = "https://127.0.0.1:4174/health";
const command = process.argv[2] ?? "start";
const execute = (args: ReadonlyArray<string>): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync([...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
const requireSuccess = (args: ReadonlyArray<string>, message: string): void => {
  if (execute(args).exitCode !== 0) throw new Error(message);
};
const trusted = (): boolean =>
  execute(["security", "verify-cert", "-p", "ssl", "-s", "127.0.0.1", "-c", certificate])
    .exitCode === 0;
const registered = (): boolean => execute(["launchctl", "print", target]).exitCode === 0;
const responding = (url: string): boolean =>
  execute(["curl", "--fail", "--silent", "--max-time", "2", "--output", "/dev/null", url])
    .exitCode === 0;
const ready = (): boolean => responding(app) && responding(api);
const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const portOccupied = (port: number): boolean =>
  execute(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).exitCode === 0;
const stop = Effect.fn(function* () {
  if (!registered()) return;
  requireSuccess(["launchctl", "bootout", target], "Could not stop the local browser service.");
  const deadline = (yield* Clock.currentTimeMillis) + startupMilliseconds;
  while ([appPort, apiPort, operatorPort].some(portOccupied)) {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      throw new Error(
        "Local browser listeners did not stop. Inspect their owner before restarting."
      );
    }
    yield* Effect.sleep(pollMilliseconds);
  }
});
const waitReady = Effect.fn(function* () {
  const deadline = (yield* Clock.currentTimeMillis) + startupMilliseconds;
  while (!ready()) {
    if (!registered()) throw new Error("The browser service stopped before startup completed.");
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      throw new Error(`Startup did not complete. Read ${directory}/server.log.`);
    }
    yield* Effect.sleep(pollMilliseconds);
  }
});
const requireFreePorts = (): void => {
  for (const port of [appPort, apiPort, operatorPort]) {
    if (portOccupied(port)) {
      throw new Error(
        `Port ${port} is occupied. Stop its owner before starting Fidy; no process was killed.`
      );
    }
  }
};
const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (Bun.which("mkcert") === null) throw new Error("Install mkcert first: brew install mkcert");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  requireSuccess(
    ["mkcert", "-cert-file", certificate, "-key-file", key, "127.0.0.1", "localhost", "::1"],
    "Could not create the local HTTPS certificate."
  );
  yield* fs.chmod(key, privateFileMode);
  if (!trusted()) {
    const ca = execute(["mkcert", "-CAROOT"]);
    if (ca.exitCode !== 0) throw new Error("Could not locate the mkcert CA.");
    const installation = Bun.spawn(
      [
        "security",
        "add-trusted-cert",
        "-r",
        "trustRoot",
        "-k",
        `${homedir()}/Library/Keychains/login.keychain-db`,
        `${new TextDecoder().decode(ca.stdout).trim()}/rootCA.pem`,
      ],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
    );
    if (
      (yield* Effect.tryPromise({
        try: () => installation.exited,
        catch: () => new CertificateProcessFailure(),
      })) !== 0 ||
      !trusted()
    ) {
      throw new Error("Approve the macOS certificate trust prompt, then rerun setup.");
    }
  }
  print("Local HTTPS certificate is trusted. Run bun run dev:browser.");
});
const start = Effect.fn(function* () {
  const executablePath = yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"));
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(certificate)) || !trusted()) {
    throw new Error(
      "Local HTTPS is not ready. Run bun run dev:browser setup once and approve the macOS prompt."
    );
  }
  if (registered() && ready()) {
    print(`Already running: ${app}/app/recurring`);
    return;
  }
  yield* stop();
  requireFreePorts();
  yield* fs.makeDirectory(`${homedir()}/Library/LaunchAgents`, { recursive: true });
  yield* fs.writeFileString(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(`${root}/scripts/dev-browser-server.ts`)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(executablePath)}</string></dict>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key><string>${xml(`${directory}/server.log`)}</string>
<key>StandardErrorPath</key><string>${xml(`${directory}/server.log`)}</string>
</dict></plist>\n`
  );
  requireSuccess(
    ["launchctl", "bootstrap", `gui/${process.getuid?.()}`, plist],
    "Could not register the local browser service."
  );
  requireSuccess(["launchctl", "kickstart", target], "Could not start the local browser service.");
  yield* waitReady().pipe(
    Effect.onExit((exit) => (exit._tag === "Failure" ? stop() : Effect.void))
  );
  print(
    `Ready: ${app}/app/recurring\nTest login: ${app}/login\nLogs: ${directory}/server.log\nStop: bun run dev:browser stop`
  );
});

const requireMacOS = (): void => {
  if (process.platform !== "darwin") {
    throw new Error(
      "This persistent browser helper supports macOS. Use bun run dev or the browser acceptance commands on other platforms."
    );
  }
};
const program = Effect.gen(function* () {
  requireMacOS();
  if (command === "setup") yield* setup();
  else if (command === "start") yield* start();
  else if (command === "stop") {
    yield* stop();
    print("Local browser service stopped.");
  } else if (command === "restart") {
    yield* stop();
    yield* start();
  } else if (command === "status") {
    if (!registered() || !ready()) {
      throw new Error("Local browser service is not ready. Run bun run dev:browser.");
    }
    print(`Ready: ${app}/app/recurring`);
  } else throw new Error("Use start, setup, stop, restart, or status.");
});
await Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer))).catch(
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Local browser setup failed."}\n`
    );
    process.exitCode = 1;
  }
);
