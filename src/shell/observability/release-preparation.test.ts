import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fullSha = "0123456789abcdef0123456789abcdef01234567";
const release = `fidy@${fullSha}`;
const sentryArgumentsPrefix = "--url https://sentry.io/";
const temporaryRoots: Array<string> = [];

const makeArtifactPair = async (
  root: string,
  name: string,
  debugIds: Readonly<{ javascript: string; sourceMap: string }>
): Promise<void> => {
  const javascript = `${root}/dist/${name}.js`;
  await Bun.write(javascript, `console.log("built");\n//# debugId=${debugIds.javascript}\n`);
  await Bun.write(
    `${javascript}.map`,
    JSON.stringify({
      version: 3,
      sources: [`src/${name}.ts`],
      debugId: debugIds.sourceMap,
    })
  );
};

const makeHarness = async (): Promise<Readonly<{ root: string; calls: string }>> => {
  const root = await mkdtemp(join(tmpdir(), "fidy-release-"));
  temporaryRoots.push(root);
  const build = await Bun.build({
    entrypoints: [`${process.cwd()}/scripts/prepare-sentry-release.ts`],
    outdir: `${root}/dist/commands`,
    target: "bun",
    sourcemap: "external",
  });
  if (!build.success) throw new Error("Could not build the release-preparation test command.");
  const command = `${root}/dist/commands/prepare-sentry-release.js`;
  const commandMap = `${command}.map`;
  const commandDebugId = "44444444-4444-4444-8444-444444444444";
  await Bun.write(command, `${await Bun.file(command).text()}\n//# debugId=${commandDebugId}\n`);
  const sourceMap = (await Bun.file(commandMap).text()).trimEnd();
  if (!sourceMap.endsWith("}")) throw new Error("Built command source map is not a JSON object.");
  await Bun.write(commandMap, `${sourceMap.slice(0, -1)},"debugId":"${commandDebugId}"}`);

  const calls = `${root}/sentry-calls`;
  const trustedCli = `${root}/dist/commands/sentry-cli`;
  await Bun.write(
    trustedCli,
    `#!/bin/sh
set -eu
printf '%s|%s\\n' "$*" "\${SENTRY_URL-unset}" >> "${calls}"
if [ -e "${root}/fail-upload" ] && echo "$*" | grep -q "sourcemaps upload"; then
  exit 23
fi
`
  );
  await Bun.$`chmod +x ${trustedCli}`.quiet();
  const pathCli = `${root}/bin/sentry-cli`;
  await Bun.write(
    pathCli,
    `#!/bin/sh
printf '%s' "\${SENTRY_AUTH_TOKEN-unset}" > "${root}/path-hijacked"
exit 99
`
  );
  await Bun.$`chmod +x ${pathCli}`.quiet();
  await makeArtifactPair(root, "main", {
    javascript: "11111111-1111-4111-8111-111111111111",
    sourceMap: "11111111-1111-4111-8111-111111111111",
  });
  await makeArtifactPair(root, "preload", {
    javascript: "22222222-2222-4222-8222-222222222222",
    sourceMap: "22222222-2222-4222-8222-222222222222",
  });
  return { root, calls };
};

const runPreparation = (
  harness: Readonly<{ root: string; calls: string }>,
  overrides: Readonly<Record<string, string>> = {}
): Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> =>
  Bun.spawnSync([process.execPath, `${harness.root}/dist/commands/prepare-sentry-release.js`], {
    cwd: harness.root,
    env: {
      ...process.env,
      PATH: `${harness.root}/bin:${process.env.PATH ?? ""}`,
      RAILWAY_GIT_COMMIT_SHA: fullSha,
      SENTRY_RELEASE: release,
      SENTRY_AUTH_TOKEN: "upload-token-sentinel",
      SENTRY_ORG: "fidy-org",
      SENTRY_PROJECT: "fidy-api",
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => Bun.$`rm -rf ${root}`.quiet()));
});

describe("Sentry release preparation", () => {
  it("uploads the built debug-ID artifacts between idempotent release creation and finalization", async () => {
    const harness = await makeHarness();

    const first = runPreparation(harness);
    const second = runPreparation(harness);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(await Bun.file(harness.calls).text()).toBe(
      [
        `${sentryArgumentsPrefix} releases new ${release}|unset`,
        `${sentryArgumentsPrefix} sourcemaps upload --release ${release} --validate --strict --wait --wait-for 8 dist|unset`,
        `${sentryArgumentsPrefix} releases finalize ${release}|unset`,
        `${sentryArgumentsPrefix} releases new ${release}|unset`,
        `${sentryArgumentsPrefix} sourcemaps upload --release ${release} --validate --strict --wait --wait-for 8 dist|unset`,
        `${sentryArgumentsPrefix} releases finalize ${release}|unset`,
        "",
      ].join("\n")
    );
  });

  it("rejects a release that does not equal the Railway full commit SHA before contacting Sentry", async () => {
    const harness = await makeHarness();

    const result = runPreparation(harness, {
      SENTRY_RELEASE: "fidy@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "SENTRY_RELEASE must equal fidy@ plus RAILWAY_GIT_COMMIT_SHA"
    );
    expect(await Bun.file(harness.calls).exists()).toBe(false);
  });

  it("rejects a source map whose debug ID does not match its running JavaScript", async () => {
    const harness = await makeHarness();
    await makeArtifactPair(harness.root, "main", {
      javascript: "11111111-1111-4111-8111-111111111111",
      sourceMap: "33333333-3333-4333-8333-333333333333",
    });

    const result = runPreparation(harness);

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "JavaScript and source map debug IDs differ"
    );
    expect(await Bun.file(harness.calls).exists()).toBe(false);
  });

  it("bounds retries and identifies entitlement when required source-map upload is rejected", async () => {
    const harness = await makeHarness();
    await Bun.write(`${harness.root}/fail-upload`, "reject upload");

    const result = runPreparation(harness);

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "verify the org:ci token, project access, source-map upload entitlement"
    );
    const calls = (await Bun.file(harness.calls).text()).trim().split("\n");
    expect(
      calls.filter((call) => call.startsWith(`${sentryArgumentsPrefix} sourcemaps upload`))
    ).toHaveLength(3);
    expect(calls.some((call) => call.includes("releases finalize"))).toBe(false);
  });

  it("pins the Sentry endpoint and does not forward an environment destination", async () => {
    const harness = await makeHarness();

    const result = runPreparation(harness, { SENTRY_URL: "https://attacker.example" });

    expect(result.exitCode).toBe(0);
    const calls = await Bun.file(harness.calls).text();
    expect(calls).toContain(`${sentryArgumentsPrefix} releases new ${release}|unset`);
    expect(calls).not.toContain("attacker.example");
    expect(await Bun.file(`${harness.root}/path-hijacked`).exists()).toBe(false);
  });
});
