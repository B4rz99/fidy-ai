import { afterEach, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures: Array<string> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) Bun.spawnSync(["rm", "-rf", fixture]);
});

const installer = await Bun.file(new URL("./install-workspace.sh", import.meta.url)).text();
const authorizedLock = await Bun.file(new URL("../bun.lock", import.meta.url)).text();

const runInstaller = async (
  lock: string,
  day: string,
  args: ReadonlyArray<string> = []
): Promise<Bun.SyncSubprocess> => {
  const root = mkdtempSync(join(tmpdir(), "fidy-install-"));
  fixtures.push(root);
  await Bun.write(`${root}/scripts/install-workspace.sh`, installer);
  await Bun.write(`${root}/bun.lock`, lock);
  await Bun.write(`${root}/bin/bun`, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  await Bun.write(`${root}/bin/date`, `#!/usr/bin/env bash\nprintf '%s\\n' '${day}'\n`);
  Bun.spawnSync(["chmod", "+x", `${root}/bin/bun`, `${root}/bin/date`]);
  return Bun.spawnSync(["bash", `${root}/scripts/install-workspace.sh`, ...args], {
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
  });
};

it("admits only the authorized frozen snapshot before expiry and preserves script suppression", async () => {
  const result = await runInstaller(authorizedLock, "2026-10-09", ["--ignore-scripts"]);
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe(
    "install\n--frozen-lockfile\n--minimum-release-age=0\n--ignore-scripts\n"
  );
});

it("uses the ordinary cooldown for a changed dependency snapshot", async () => {
  const result = await runInstaller(`${authorizedLock}\n`, "2026-10-09");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe("install\n--frozen-lockfile\n");
});

it("returns to the ordinary cooldown at the exception deadline", async () => {
  const result = await runInstaller(authorizedLock, "2026-10-10");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe("install\n--frozen-lockfile\n");
});

it("refuses arguments that could change the admitted install graph", async () => {
  const result = await runInstaller(authorizedLock, "2026-10-09", ["--no-save"]);
  expect(result.exitCode).toBe(2);
  expect(new TextDecoder().decode(result.stdout)).toBe("");
});
