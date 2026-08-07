#!/usr/bin/env bun

// The convention is not defined in this file. It is parsed out of README.md's
// "Commit convention" section, which is therefore the allowlist itself rather
// than a description of one. Three consumers read this module — the commit-msg
// hook, the pre-push hook and the `PR Title` CI check — so a list kept here
// would be a fourth copy of a list that has already drifted twice: the README
// documented a `docs` scope and `test`/`perf` types that the hook rejected.
//
// Parsing is strict on purpose. A missing marker or an empty table throws
// rather than falling back to "allow everything", because a silently permissive
// hook is worse than a broken one.

import { Option } from "effect";

const TYPES_MARKER = "<!-- commit-types -->";

const HEADER_PATTERN = /^([a-z]+)\(([a-z0-9-]+)\): (.+)$/;

// A data row of a scope table: the scope in a code span, then its "when to use"
// cell. The header and separator rows carry no code span, so they never match.
const SCOPE_ROW_PATTERN = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(\S[^|]*?)\s*\|$/;

const HEADER_SHAPE_ERROR = "Commit header must follow format: type(scope): message";

const NAME_COLUMN = 14;

type ScopeSection = {
  /** The HTML comment in README.md the table follows. */
  readonly marker: string;
  /** Printed above the group in the failure message. */
  readonly lead: string;
};

type ScopeEntry = {
  readonly name: string;
  readonly when: string;
};

type ScopeGroup = {
  readonly lead: string;
  readonly scopes: readonly ScopeEntry[];
};

type Allowlist = {
  readonly types: readonly string[];
  readonly scopeGroups: readonly ScopeGroup[];
};

/**
 * The published convention, ready to judge a header or a whole message. Every
 * failure it reports is followed by the current list, so a rejected message can
 * be fixed from the terminal.
 */
export type CommitConvention = {
  readonly validateHeader: (header: string) => readonly string[];
  readonly validateMessage: (message: string) => readonly string[];
  readonly formatErrors: (errors: readonly string[]) => string;
};

const CONVENTION_SOURCE = new URL("../README.md", import.meta.url);

// Order matters: it is the order scopes are printed in, slices first.
const SCOPE_SECTIONS: readonly ScopeSection[] = [
  {
    marker: "<!-- commit-scopes:slices -->",
    lead: "  the slice the change lands in — a commit almost always lands in exactly one:",
  },
  {
    marker: "<!-- commit-scopes:cross-cutting -->",
    lead: "  cross-cutting — only for work that belongs to no slice:",
  },
];

const isBlank = (line: string): boolean => line.trim().length === 0;

/** The first run of non-blank lines after a marker: the list or table it labels. */
const blockAfter = (markdown: string, marker: string): readonly string[] => {
  const marked = markdown.indexOf(marker);

  if (marked === -1) {
    throw new Error(
      `README.md is missing the "${marker}" marker: the commit convention is unreadable`
    );
  }

  const lines = markdown
    .slice(marked + marker.length)
    .split(/\r?\n/)
    .slice(1);
  const block = lines.slice(lines.findIndex((line) => !isBlank(line)));
  const end = block.findIndex(isBlank);

  return end === -1 ? block : block.slice(0, end);
};

const parseTypes = (markdown: string): readonly string[] => {
  const spans = blockAfter(markdown, TYPES_MARKER)
    .join(" ")
    .match(/`[a-z]+`/g);

  if (spans === null) {
    throw new Error(`README.md lists no commit types under "${TYPES_MARKER}"`);
  }

  return spans.map((span) => span.slice(1, -1));
};

const parseScopeRow = (row: string): Option.Option<ScopeEntry> => {
  const match = SCOPE_ROW_PATTERN.exec(row.trim());

  if (match === null) {
    return Option.none();
  }

  const name = match[1];
  const when = match[2];

  if (name === undefined || when === undefined) {
    return Option.none();
  }

  return Option.some({ name, when });
};

const parseScopeGroup = (markdown: string, section: ScopeSection): ScopeGroup => {
  const scopes = blockAfter(markdown, section.marker).flatMap((row) =>
    Option.toArray(parseScopeRow(row))
  );

  if (scopes.length === 0) {
    throw new Error(`README.md lists no scopes under "${section.marker}"`);
  }

  return { lead: section.lead, scopes };
};

const parseAllowlist = (markdown: string): Allowlist => ({
  types: parseTypes(markdown),
  scopeGroups: SCOPE_SECTIONS.map((section) => parseScopeGroup(markdown, section)),
});

const scopeNames = (allowlist: Allowlist): readonly string[] =>
  allowlist.scopeGroups.flatMap((group) => group.scopes.map((scope) => scope.name));

const formatScopeGroup = (group: ScopeGroup): string =>
  [
    group.lead,
    ...group.scopes.map((scope) => `    ${scope.name.padEnd(NAME_COLUMN)}${scope.when}`),
  ].join("\n");

const formatAllowlist = (allowlist: Allowlist): string =>
  `Required commit message format:
type(scope): message

- concise body bullet
- another body bullet

type: ${allowlist.types.join(" | ")}

scope:
${allowlist.scopeGroups.map(formatScopeGroup).join("\n\n")}

body: required; every line must start with "- "`;

const headerErrors = (header: string, allowlist: Allowlist): readonly string[] => {
  const match = HEADER_PATTERN.exec(header);

  if (match === null) {
    return [HEADER_SHAPE_ERROR];
  }

  const type = match[1];
  const scope = match[2];
  const summary = match[3];

  if (type === undefined || scope === undefined || summary === undefined) {
    return [HEADER_SHAPE_ERROR];
  }

  const errors: string[] = [];

  if (!allowlist.types.includes(type)) {
    errors.push(`Invalid type "${type}". Use one of: ${allowlist.types.join(", ")}`);
  }

  if (!scopeNames(allowlist).includes(scope)) {
    errors.push(`Invalid scope "${scope}". Use one of the scopes listed below`);
  }

  return errors;
};

const messageErrors = (message: string, allowlist: Allowlist): readonly string[] => {
  const lines = message.split(/\r?\n/);
  const header = lines[0] ?? "";
  const errors = headerErrors(header, allowlist);

  if (errors.length > 0) {
    return errors;
  }

  const bodyLines = lines
    .slice(2)
    .filter((line) => line.trim().length > 0 && !line.startsWith("#"));
  const badBodyLine = bodyLines.find((line) => !line.startsWith("- "));

  if (bodyLines.length === 0) {
    return ["Commit body must contain at least one bullet point (- description)"];
  }

  if (badBodyLine !== undefined) {
    return ["Commit body must contain bullet points only (- description)"];
  }

  return [];
};

/**
 * Parses the convention out of `markdown` — any document carrying the README's
 * markers, not README.md alone. Throws when a marker is missing, or when the
 * list or table under it holds no entries.
 */
export const parseCommitConvention = (markdown: string): CommitConvention => {
  const allowlist = parseAllowlist(markdown);

  return {
    validateHeader: (header) => headerErrors(header, allowlist),
    validateMessage: (message) => messageErrors(message, allowlist),
    formatErrors: (errors) => `${errors.join("\n")}\n\n${formatAllowlist(allowlist)}`,
  };
};

/**
 * The convention as README.md publishes it, re-read on every call. Rejects when
 * the file cannot be read or does not parse.
 */
export const loadCommitConvention = (): Promise<CommitConvention> =>
  Bun.file(CONVENTION_SOURCE).text().then(parseCommitConvention);

if (import.meta.main) {
  const messagePath = Bun.argv[2];

  if (messagePath === undefined) {
    process.stderr.write("Usage: bun scripts/check-commit-message.ts <commit-msg-file>\n");
    process.exit(1);
  }

  const convention = await loadCommitConvention();
  const errors = convention.validateMessage(await Bun.file(messagePath).text());

  if (errors.length > 0) {
    process.stderr.write(`${convention.formatErrors(errors)}\n`);
    process.exit(1);
  }
}
