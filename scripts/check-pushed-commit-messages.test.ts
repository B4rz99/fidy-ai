import { afterEach, describe, expect, it } from "vitest";

const script = new URL("./check-pushed-commit-messages.ts", import.meta.url).pathname;
const temporaryRepositories: Array<string> = [];
const validMessage =
  "test(repo): #1135 exercise pushed commit scope\n\n- Keep the required convention.";
const malformedMessage = "test(repo): #1135 upstream squash fixture\n\n* Non-bullet squash body.";
const zeroSha = "0".repeat(40);

afterEach(() => {
  for (const directory of temporaryRepositories.splice(0)) {
    Bun.spawnSync(["rm", "-rf", directory]);
  }
});

type HookFixture = {
  readonly git: (...args: Array<string>) => string;
  readonly base: string;
  readonly check: (localSha: string, remoteSha: string) => Bun.SyncSubprocess<"pipe", "pipe">;
};

const fixture = (): HookFixture => {
  const temporary = Bun.spawnSync(["mktemp", "-d"]);
  expect(temporary.exitCode).toBe(0);
  const cwd = new TextDecoder().decode(temporary.stdout).trim();
  temporaryRepositories.push(cwd);
  const git = (...args: Array<string>): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    return new TextDecoder().decode(result.stdout).trim();
  };
  git("init", "--quiet", "--initial-branch=task", "--template=");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-qm", validMessage);
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/task", base);
  git("update-ref", "refs/remotes/origin/trunk", base);
  const check = (localSha: string, remoteSha: string): Bun.SyncSubprocess<"pipe", "pipe"> =>
    Bun.spawnSync(["bun", script], {
      cwd,
      stdin: new TextEncoder().encode(`refs/heads/task ${localSha} refs/heads/task ${remoteSha}\n`),
    });
  return { git, base, check };
};

describe("pushed commit message scope", () => {
  it("does not revalidate already-fetched trunk commits merged into an existing branch", () => {
    const repository = fixture();
    repository.git("switch", "-c", "trunk");
    repository.git("commit", "--allow-empty", "-qm", malformedMessage);
    repository.git("update-ref", "refs/remotes/origin/trunk", "HEAD");
    repository.git("switch", "task");
    repository.git("commit", "--allow-empty", "-qm", validMessage);
    repository.git("merge", "--no-ff", "trunk", "-m", validMessage);
    const result = repository.check(repository.git("rev-parse", "HEAD"), repository.base);
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  });

  it("still rejects a new malformed commit introduced through a local side branch", () => {
    const repository = fixture();
    repository.git("switch", "-c", "local-only");
    repository.git("commit", "--allow-empty", "-qm", malformedMessage);
    const malformed = repository.git("rev-parse", "HEAD");
    repository.git("switch", "task");
    repository.git("commit", "--allow-empty", "-qm", validMessage);
    repository.git("merge", "--no-ff", "local-only", "-m", validMessage);
    const result = repository.check(repository.git("rev-parse", "HEAD"), repository.base);
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(malformed.slice(0, 12));
  });

  it("keeps new-branch checks and branch deletion behavior", () => {
    const repository = fixture();
    repository.git("commit", "--allow-empty", "-qm", malformedMessage);
    const malformed = repository.git("rev-parse", "HEAD");
    const added = repository.check(malformed, zeroSha);
    expect(added.exitCode).toBe(1);
    expect(new TextDecoder().decode(added.stderr)).toContain(malformed.slice(0, 12));
    expect(repository.check(zeroSha, malformed).exitCode).toBe(0);
  });
});
