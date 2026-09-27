#!/usr/bin/env bun

// Bans first-party lint and Effect language-service suppression directives.
// This must run outside the linter: a file-scoped directive can silence even
// the rule intended to catch it. Keep the directive spellings split across
// strings below so this checker checks itself without an exclusion list.

type Suppression = {
  readonly file: string;
  readonly line: number;
  /** The offending line, trimmed. */
  readonly source: string;
};

const SUPPRESSION_PATTERN = new RegExp(
  ["(?:ox|es)lint-disable", "@effect" + "-diagnostics(?:-next-line)?\\b"].join("|")
);
// These diagnostics have no first-party path that needs an opt-out. Scoped platform
// boundaries use other, reviewable overrides in tsconfig.base.json.
const UNJUSTIFIED_DIAGNOSTIC_DISABLED =
  /"(?:asyncFunction|missingPipeableSignature|strictBooleanExpressions)"\s*:\s*"off"/;

/**
 * Every extension oxlint will lint — wider than this repo writes today, on
 * purpose. `oxlint .` picks up a `.mts` or a `.vue` file the day it lands, so a
 * directive in one silences real rules from that same day; a list that tracked
 * only the extensions already present would reopen this hole per new file type.
 */
const LINTED_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
];

// A vendored reference checkout: tracked in full, so git lists it, but never
// built, shipped or edited by us. It is the only entry this list needs —
// node_modules, dist, build and coverage are gitignored, and
// `--exclude-standard` never lists an ignored path.
const NOT_FIRST_PARTY = [".repos/"];

const repoRoot = Bun.fileURLToPath(new URL("..", import.meta.url));

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Tracked files plus untracked ones git would not ignore. Include TypeScript
 * configs so a path override cannot silently disable a required diagnostic.
 */
const checkedFiles = (): readonly string[] => {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }
  );

  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${decode(listed.stderr).trim()}`);
  }

  return (
    decode(listed.stdout)
      .split("\0")
      .filter(
        (path) =>
          LINTED_EXTENSIONS.some((extension) => path.endsWith(extension)) ||
          /(?:^|\/)tsconfig[^/]*\.json$/.test(path)
      )
      .filter((path) => !NOT_FIRST_PARTY.some((directory) => path.startsWith(directory)))
      // `git ls-files --cached` retains a deleted path until the deletion is staged;
      // do not try to read that stale index entry.
      .filter((path) => Bun.file(`${repoRoot}${path}`).size > 0)
  );
};

export const suppressionsIn = ({
  file,
  contents,
}: Readonly<{ file: string; contents: string }>): readonly Suppression[] =>
  contents
    .split(/\r?\n/)
    .flatMap((source, index) =>
      SUPPRESSION_PATTERN.test(source) ||
      (file.endsWith(".json") && UNJUSTIFIED_DIAGNOSTIC_DISABLED.test(source))
        ? [{ file, line: index + 1, source: source.trim() }]
        : []
    );

if (import.meta.main) {
  const scanned = await Promise.all(
    checkedFiles().map((file) =>
      Bun.file(`${repoRoot}${file}`)
        .text()
        .then((contents) => suppressionsIn({ file, contents }))
    )
  );
  const found = scanned.flat();
  if (found.length > 0) {
    const report = found.map(({ file, line, source }) => `${file}:${line}: ${source}`).join("\n");
    process.stderr.write(
      `${report}\n\n` +
        `${found.length} lint suppression directive(s) in first-party source.\n\n` +
        `A suppression turns off a rule at the place it would report a problem. ` +
        `Fix the code rather than disabling a diagnostic with a comment or config override.\n`
    );
    process.exit(1);
  }
}
