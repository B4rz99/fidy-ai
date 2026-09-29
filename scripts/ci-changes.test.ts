import { afterEach, describe, expect, it } from "vitest";
import { selectChecks } from "./ci-changes";

const root = process.cwd();
const fixtures: Array<string> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) Bun.spawnSync(["rm", "-rf", fixture]);
});

const selectedJobs = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  Object.entries(selectChecks(paths))
    .filter(([, selected]) => selected)
    .map(([job]) => job);

const allJobs = [
  "builds",
  "unit",
  "cloudflare-adapters",
  "cloudflare-infra",
  "browser",
  "security-sast",
  "security-sca",
];

describe("PR check selection", () => {
  it("leaves prose and agent guidance to the workspace and secret gates", () => {
    expect(
      selectedJobs([
        "README.md",
        "docs/adr/decision.md",
        "apps/web/ARCHITECTURE.md",
        ".agents/skills/demo/SKILL.md",
      ])
    ).toEqual([]);
    expect(selectedJobs([])).toEqual([]);
  });

  it("checks web changes without starting unrelated server adapters or dependency scans", () => {
    expect(selectedJobs(["apps/web/src/main.tsx"])).toEqual([
      "builds",
      "unit",
      "cloudflare-infra",
      "browser",
      "security-sast",
    ]);
  });

  it("checks real Worker browser journeys and infrastructure when server behavior changes", () => {
    expect(selectedJobs(["apps/server/src/core/money.ts"])).toEqual([
      "builds",
      "unit",
      "cloudflare-adapters",
      "cloudflare-infra",
      "browser",
      "security-sast",
    ]);
    expect(selectedJobs(["infra/cloudflare/edge-security.ts"])).toEqual([
      "builds",
      "unit",
      "cloudflare-adapters",
      "cloudflare-infra",
      "browser",
      "security-sast",
    ]);
  });

  it("invalidates every check for shared dependencies, executable evidence, and unfamiliar owners", () => {
    for (const path of [
      "bun.lock",
      "apps/web/package.json",
      "tools/depcruise/bun.lock",
      ".agents/skills/demo/package.json",
      "apps/server/requirements.txt",
      "apps/web/pnpm-lock.yaml",
      "research/prototype.ts",
      "bunfig.toml",
      "tsconfig.base.json",
      "scripts/verify.ts",
      ".github/workflows/ci.yml",
      "docs/operations/kapso-launch-evidence.json",
      "apps/new-worker/index.ts",
    ]) {
      expect(selectedJobs([path]), path).toEqual(allJobs);
    }
    // Markdown under application trees may be an ingestion fixture, not documentation.
    expect(selectedJobs(["apps/server/tools/fixtures/message.md"])).toContain("unit");
  });

  it("runs the owning security scanner when only its configuration changes", () => {
    expect(selectedJobs([".fluidattacks/sca.yaml"])).toEqual(["security-sca"]);
    expect(selectedJobs([".fluidattacks/sast.yaml"])).toEqual(["security-sast"]);
    expect(selectedJobs([".gitleaks.toml", ".fluidattacks/secrets.yaml"])).toEqual([]);
  });

  it("uses the merge base, includes both sides of moves, and does not truncate large diffs", () => {
    const temporary = Bun.spawnSync(["mktemp", "-d"]);
    expect(temporary.exitCode).toBe(0);
    const cwd = new TextDecoder().decode(temporary.stdout).trim();
    fixtures.push(cwd);
    const writeFixture = (path: string, content: string): void => {
      const result = Bun.spawnSync([
        "sh",
        "-c",
        'mkdir -p "$(dirname "$2")" && printf %s "$1" > "$2"',
        "fixture",
        content,
        `${cwd}/${path}`,
      ]);
      expect(result.exitCode).toBe(0);
    };
    const git = (...args: ReadonlyArray<string>): string => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd,
        env: {
          ...Bun.env,
          GIT_AUTHOR_NAME: "CI test",
          GIT_AUTHOR_EMAIL: "ci@example.test",
          GIT_COMMITTER_NAME: "CI test",
          GIT_COMMITTER_EMAIL: "ci@example.test",
        },
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      return new TextDecoder().decode(result.stdout).trim();
    };
    git("init", "--initial-branch=trunk");
    writeFixture("apps/server/original.ts", "export const fixture = true;\n");
    git("add", ".");
    git("commit", "-m", "initial");
    git("checkout", "-b", "topic");
    writeFixture("docs/moved.md", "export const fixture = true;\n");
    expect(Bun.spawnSync(["rm", `${cwd}/apps/server/original.ts`]).exitCode).toBe(0);
    const documents = Bun.spawnSync([
      "bash",
      "-c",
      'for index in {0..349}; do printf prose > "$1/docs/change-$index.md"; done',
      "fixture",
      cwd,
    ]);
    expect(documents.exitCode).toBe(0);
    git("add", ".");
    git("commit", "-m", "move server fixture to docs");
    const head = git("rev-parse", "HEAD");
    git("checkout", "trunk");
    writeFixture("package.json", "{}\n");
    git("add", ".");
    git("commit", "-m", "unrelated base change");
    const base = git("rev-parse", "HEAD");
    const output = `${cwd}/outputs`;
    const result = Bun.spawnSync(["bun", `${root}/scripts/ci-changes.ts`], {
      cwd,
      env: { ...Bun.env, PR_BASE_SHA: base, PR_HEAD_SHA: head, GITHUB_OUTPUT: output },
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);

    const invalid = Bun.spawnSync(["bun", `${root}/scripts/ci-changes.ts`], {
      cwd,
      env: { ...Bun.env, PR_BASE_SHA: "0".repeat(40), PR_HEAD_SHA: head, GITHUB_OUTPUT: output },
    });
    expect(invalid.exitCode).not.toBe(0);
    return Bun.file(output)
      .text()
      .then((plan) => {
        expect(plan).toContain("cloudflare-adapters=true\n");
        expect(plan).toContain("browser=true\n");
        // A two-dot comparison would wrongly attribute trunk's package.json to this PR.
        expect(plan).toContain("security-sca=false\n");
      });
  });
});

const gate = (
  selection: string,
  result: string,
  outcomes: { readonly detector: string; readonly staticResult: string } = {
    detector: "success",
    staticResult: "success",
  }
): number => {
  const execution = Bun.spawnSync(["bash", `${root}/scripts/check-ci-results.sh`], {
    env: {
      ...Bun.env,
      RESULTS: JSON.stringify({
        changes: { result: outcomes.detector, outputs: { browser: selection } },
        static: { result: outcomes.staticResult, outputs: {} },
        browser: { result, outputs: {} },
      }),
    },
  });
  return execution.exitCode;
};

describe("Required Checks", () => {
  it("accepts successful selected checks and explicitly unselected skipped checks", () => {
    expect(gate("true", "success")).toBe(0);
    expect(gate("false", "skipped")).toBe(0);
  });

  it("rejects failed or cancelled checks, unexpected skips, and failed change detection", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(gate("true", result)).not.toBe(0);
    }
    expect(gate("false", "failure")).not.toBe(0);
    expect(gate("false", "skipped", { detector: "failure", staticResult: "success" })).not.toBe(0);
    expect(gate("false", "skipped", { detector: "success", staticResult: "skipped" })).not.toBe(0);
    expect(gate("", "skipped")).not.toBe(0);
  });
});
