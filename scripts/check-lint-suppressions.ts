#!/usr/bin/env bun

// Bans lint suppression directives in first-party source, and it has to live
// outside the linter to do it: a whole-file `/* …-disable */` turns off every
// oxlint rule in that file, including any rule written to catch the directive
// itself. `.oxlintrc.json` is the gate the two trees rest on — the core fence,
// the escape-hatch ban, the import restrictions — and one comment above a
// declaration was enough to opt out of all of it. The repo already bans
// `@ts-ignore` and `@ts-expect-error` through `typescript/ban-ts-comment`; this
// closes the same door on oxlint's own escape hatch.
//
// There is no exclusion list, not even for this file, which is why the pattern
// below is written as an alternation over the prefix rather than spelling the
// two directive names out. Spell them out and this file starts matching itself,
// and the first thing anyone would reach for is an exclusion — at which point
// the check has a hole in exactly the shape of the check.

type Suppression = {
  readonly file: string;
  readonly line: number;
  /** The offending line, trimmed. */
  readonly source: string;
};

const SUPPRESSION_PATTERN = /(?:ox|es)lint-disable/;

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
 * Tracked files plus untracked ones git would not ignore — the same set oxlint
 * walks, so a file added and not yet committed is checked too.
 */
const lintedFiles = (): readonly string[] => {
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
      .filter((path) => LINTED_EXTENSIONS.some((extension) => path.endsWith(extension)))
      .filter((path) => !NOT_FIRST_PARTY.some((directory) => path.startsWith(directory)))
      // `git ls-files --cached` retains a deleted path until the deletion is staged;
      // do not try to read that stale index entry.
      .filter((path) => Bun.file(`${repoRoot}${path}`).size > 0)
  );
};

const suppressionsIn = (file: string, contents: string): readonly Suppression[] =>
  contents
    .split(/\r?\n/)
    .flatMap((source, index) =>
      SUPPRESSION_PATTERN.test(source) ? [{ file, line: index + 1, source: source.trim() }] : []
    );

const scanned = await Promise.all(
  lintedFiles().map((file) =>
    Bun.file(`${repoRoot}${file}`)
      .text()
      .then((contents) => suppressionsIn(file, contents))
  )
);

const found = scanned.flat();

if (found.length > 0) {
  const report = found.map(({ file, line, source }) => `${file}:${line}: ${source}`).join("\n");

  process.stderr.write(
    `${report}\n\n` +
      `${found.length} lint suppression directive(s) in first-party source.\n\n` +
      `A suppression turns the gate off at the one place it was about to fire, and a ` +
      `whole-file one turns off every rule in the file — the core fence, the escape-hatch ` +
      `ban and the import restrictions included. A rule a tool could enforce, but no tool ` +
      `runs, is not a standard (CODING_STANDARDS.md) — and a rule anyone can switch off with ` +
      `a comment is one that no longer runs.\n\n` +
      `Fix the code, or change the rule in .oxlintrc.json so the exception is written down ` +
      `once, in the open, with a reason.\n`
  );
  process.exit(1);
}
