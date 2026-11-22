import { BunFileSystem } from "@effect/platform-bun";
import { Clock, Config, Data, Effect, FileSystem, Predicate } from "effect";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

class CertificateProcessFailure extends Data.TaggedError("CertificateProcessFailure") {}

class DevBrowserFailure extends Data.TaggedError("DevBrowserFailure")<{
  readonly message: string;
}> {}

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

const serverScript = `${root}/scripts/dev-browser-server.ts`;

const serverLog = `${directory}/server.log`;

const serviceGroupFile = `${directory}/server.pgid`;

const nssDatabase = `sql:${homedir()}/.pki/nssdb`;

const macOS = process.platform === "darwin";

const app = "https://127.0.0.1:4173";

const api = "https://127.0.0.1:4174/health";

const command = process.argv[2] ?? "start";

const execute = (args: ReadonlyArray<string>): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync([...args], { cwd: root, stdout: "pipe", stderr: "pipe" });

const requireSuccess = (args: ReadonlyArray<string>, message: string): void => {
  if (execute(args).exitCode !== 0) throw new Error(message);
};

const trustedByMacOS = (): boolean =>
  execute(["security", "verify-cert", "-p", "ssl", "-s", "127.0.0.1", "-c", certificate])
    .exitCode === 0;

const trustedByLinux = (): boolean =>
  execute(["openssl", "verify", certificate]).exitCode === 0 &&
  new TextDecoder()
    .decode(execute(["certutil", "-d", nssDatabase, "-L"]).stdout)
    .includes("mkcert development CA");

const trusted = (): boolean => (macOS ? trustedByMacOS() : trustedByLinux());

const serviceGroup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;

  const group = yield* fs
    .readFileString(serviceGroupFile)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));

  return /^[1-9][0-9]*$/u.test(group.trim()) ? group.trim() : undefined;
});

const registered = Effect.fn(function* () {
  if (macOS) return execute(["launchctl", "print", target]).exitCode === 0;
  const group = yield* serviceGroup();

  return group !== undefined && execute(["pgrep", "-g", group]).exitCode === 0;
});

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
  if (!(yield* registered())) return;
  requireSuccess(
    macOS
      ? ["launchctl", "bootout", target]
      : ["pkill", "-TERM", "-g", (yield* serviceGroup()) ?? ""],
    "Could not stop the local browser service."
  );
  const deadline = (yield* Clock.currentTimeMillis) + startupMilliseconds;

  while ([appPort, apiPort, operatorPort].some(portOccupied)) {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* new DevBrowserFailure({
        message: "Local browser listeners did not stop. Inspect their owner before restarting.",
      });
    }

    yield* Effect.sleep(pollMilliseconds);
  }
});

const waitReady = Effect.fn(function* () {
  const deadline = (yield* Clock.currentTimeMillis) + startupMilliseconds;

  while (!ready()) {
    if (!(yield* registered())) {
      return yield* new DevBrowserFailure({
        message: "The browser service stopped before startup completed.",
      });
    }

    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* new DevBrowserFailure({
        message: `Startup did not complete. Read ${directory}/server.log.`,
      });
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

const runInteractive = Effect.fn(function* (args: ReadonlyArray<string>) {
  const installation = Bun.spawn([...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  return yield* Effect.tryPromise({
    try: () => installation.exited,
    catch: () => new CertificateProcessFailure(),
  });
});

const trustOnLinux = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;

  if (Bun.which("certutil") === null) {
    return yield* new DevBrowserFailure({
      message: "Install certutil first: sudo apt-get install libnss3-tools",
    });
  }

  if (!(yield* fs.exists(`${homedir()}/.pki/nssdb`))) {
    yield* fs.makeDirectory(`${homedir()}/.pki/nssdb`, { recursive: true, mode: 0o700 });
    requireSuccess(
      ["certutil", "-d", nssDatabase, "-N", "--empty-password"],
      "Could not create the browser certificate database."
    );
  }

  if ((yield* runInteractive(["mkcert", "-install"])) !== 0 || !trusted()) {
    return yield* new DevBrowserFailure({
      message: "Could not trust mkcert's CA. Rerun setup and approve the sudo prompt.",
    });
  }
});

const trustOnMacOS = Effect.fn(function* () {
  const ca = execute(["mkcert", "-CAROOT"]);

  if (ca.exitCode !== 0) {
    return yield* new DevBrowserFailure({ message: "Could not locate the mkcert CA." });
  }

  const installed = yield* runInteractive([
    "security",
    "add-trusted-cert",
    "-r",
    "trustRoot",
    "-k",
    `${homedir()}/Library/Keychains/login.keychain-db`,
    `${new TextDecoder().decode(ca.stdout).trim()}/rootCA.pem`,
  ]);

  if (installed !== 0 || !trusted()) {
    return yield* new DevBrowserFailure({
      message: "Approve the macOS certificate trust prompt, then rerun setup.",
    });
  }
});

const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;

  if (Bun.which("mkcert") === null) {
    return yield* new DevBrowserFailure({
      message: macOS
        ? "Install mkcert first: brew install mkcert"
        : "Install mkcert first: sudo apt-get install mkcert libnss3-tools",
    });
  }

  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  requireSuccess(
    ["mkcert", "-cert-file", certificate, "-key-file", key, "127.0.0.1", "localhost", "::1"],
    "Could not create the local HTTPS certificate."
  );
  yield* fs.chmod(key, privateFileMode);

  if (!trusted()) yield* macOS ? trustOnMacOS() : trustOnLinux();
  print("Local HTTPS certificate is trusted. Run bun run dev:browser.");
});

const start = Effect.fn(function* () {
  const executablePath = yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"));
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(certificate)) || !trusted()) {
    return yield* new DevBrowserFailure({
      message:
        "Local HTTPS is not ready. Run bun run dev:browser setup once and approve its trust prompt.",
    });
  }

  if ((yield* registered()) && ready()) {
    print(`Already running: ${app}/app/recurring`);

    return;
  }

  yield* stop();
  requireFreePorts();

  if (macOS) yield* launchWithLaunchd(executablePath);
  else yield* launchDetached();
  yield* waitReady().pipe(Effect.onError(() => stop().pipe(Effect.orDie)));
  print(
    `Ready: ${app}/app/recurring\nTest login: ${app}/login\nLogs: ${serverLog}\nStop: bun run dev:browser stop`
  );
});

const launchDetached = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;

  const launched = execute([
    "sh",
    "-c",
    'setsid "$0" "$1" >>"$2" 2>&1 </dev/null & echo $!',
    process.execPath,
    serverScript,
    serverLog,
  ]);

  if (launched.exitCode !== 0) {
    return yield* new DevBrowserFailure({ message: "Could not start the local browser service." });
  }

  yield* fs.writeFileString(serviceGroupFile, new TextDecoder().decode(launched.stdout));
});

const launchWithLaunchd = Effect.fn(function* (executablePath: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${homedir()}/Library/LaunchAgents`, { recursive: true });
  yield* fs.writeFileString(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(serverScript)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(executablePath)}</string></dict>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key><string>${xml(serverLog)}</string>
<key>StandardErrorPath</key><string>${xml(serverLog)}</string>
</dict></plist>\n`
  );
  requireSuccess(
    ["launchctl", "bootstrap", `gui/${process.getuid?.()}`, plist],
    "Could not register the local browser service."
  );
  requireSuccess(["launchctl", "kickstart", target], "Could not start the local browser service.");
});

const requireSupportedPlatform = (): void => {
  if (!macOS && process.platform !== "linux") {
    throw new Error(
      "This persistent browser helper supports macOS and Linux. Use bun run dev or the browser acceptance commands on other platforms."
    );
  }
};

const program = Effect.gen(function* () {
  requireSupportedPlatform();

  if (command === "setup") yield* setup();
  else if (command === "start") yield* start();
  else if (command === "stop") {
    yield* stop();
    print("Local browser service stopped.");
  } else if (command === "restart") {
    yield* stop();
    yield* start();
  } else if (command === "status") {
    if (!(yield* registered()) || !ready()) {
      return yield* new DevBrowserFailure({
        message: "Local browser service is not ready. Run bun run dev:browser.",
      });
    }

    print(`Ready: ${app}/app/recurring`);
  } else {
    return yield* new DevBrowserFailure({ message: "Use start, setup, stop, restart, or status." });
  }
});

await Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer))).catch(
  (error: unknown) => {
    process.stderr.write(
      `${Predicate.isError(error) ? error.message : "Local browser setup failed."}\n`
    );
    process.exitCode = 1;
  }
);
