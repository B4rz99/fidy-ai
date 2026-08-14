#!/usr/bin/env bun

// The Effect migrator loses migrations in two ways, neither of which raises an
// error, and neither of which local development can reveal — locally you always
// start from an empty database, where every migration runs and everything looks
// correct:
//
//   1. `if (currentId <= latestMigrationId) continue`
//      (.repos/effect/packages/effect/src/unstable/sql/Migrator.ts:250) passes
//      over any migration numbered at or below the highest id already applied.
//      Branch A takes 0007, branch B takes 0008, B merges first — A's migration
//      never runs again. Exact duplicate ids _are_ caught, loudly, at startup
//      (Migrator.ts:239); the near miss that parallel branches actually produce
//      is caught by nothing.
//   2. `Arr.flatMapNullishOr((_) => _.match(/^(\d+)_(.+)$/))` (Migrator.ts:386)
//      drops every key that misses the pattern — `String.match` returns `null`
//      and `flatMapNullishOr` turns `null` into no entry. A typo is a migration
//      that never runs and never complains.
//
// This is the check ARCHITECTURE.md §7 names: keys well-formed, ids unique, and
// every id the branch adds above the highest id already on trunk. The third
// assertion is the only mechanism anywhere that catches (1), and it has to
// compare against trunk's *tip*, not the merge base: the merge base still
// predates branch B, so it would report 0006 as the maximum and wave 0007
// through — precisely the case that breaks production.
//
// The registry is read as text, never imported, because trunk's copy has to be
// read the same way HEAD's is, and `git show trunk:<path>` yields text whose
// sibling imports do not resolve. Parsing is strict for the reason
// check-commit-message.ts is strict: a parser that shrugs at a shape it does not
// recognise reports "no migrations" and passes everything.

import { Option } from "effect";

/** The registry path inside the server package and from the repository root. */
const PACKAGE_REGISTRY_PATH = "src/shell/db/migrations/registry.ts";
const REPOSITORY_REGISTRY_PATH = `apps/server/${PACKAGE_REGISTRY_PATH}`;

const REPO_ROOT = Bun.fileURLToPath(new URL("../../", import.meta.url));

const REGISTRY_SOURCE = new URL(`../${PACKAGE_REGISTRY_PATH}`, import.meta.url);

// Overridable so the check can be pointed at whatever a pull request actually
// targets; CI passes the base branch of the pull request.
const DEFAULT_BASE_REF = "origin/trunk";

// The pattern `fromRecord` matches keys against. Anything else is dropped.
const KEY_PATTERN = /^(\d+)_(.+)$/;

// The migrator's tracking table declares `migration_id` as `integer`, so an id
// past the signed 32-bit bound cannot be recorded. Worth stating here because
// the obvious way to satisfy "number it above trunk" is a `YYYYMMDDHHMMSS`
// timestamp, which is 14 digits and overflows on the very first insert.
const MAX_MIGRATION_ID = 2_147_483_647;

const LITERAL_MARKER = "export const migrations = {";

const BRACE_DELTA: Readonly<Record<string, number>> = { "{": 1, "}": -1 };

const QUOTED = /^(["'])(.*)\1$/;

type Migration = {
  readonly key: string;
  readonly id: number;
};

/** What the check needs to judge a branch: the registry as written, and the one it is merging into. */
type RegistryComparison = {
  /** Source text of the branch's `registry.ts`. */
  readonly registry: string;
  /** `None` when the base branch has no registry at all — a base with no migrations has a maximum id of zero, not a broken check. */
  readonly baseRegistry: Option.Option<string>;
  /** Named in failure messages so a reader knows what the ids were compared against. */
  readonly baseRef: string;
};

const braceDelta = (char: string): number => BRACE_DELTA[char] ?? 0;

/** Index of the `}` closing the brace at `open`, or -1 if the source runs out first. */
const closingBrace = (source: string, open: number): number => {
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    depth += braceDelta(source.charAt(index));

    if (depth === 0) {
      return index;
    }
  }

  return -1;
};

const literalBody = (source: string): string => {
  const marked = source.indexOf(LITERAL_MARKER);

  if (marked === -1) {
    throw new Error(
      `${PACKAGE_REGISTRY_PATH} has no "${LITERAL_MARKER}" declaration: the migration index is unreadable`
    );
  }

  const open = marked + LITERAL_MARKER.length - 1;
  const close = closingBrace(source, open);

  if (close === -1) {
    throw new Error(`${PACKAGE_REGISTRY_PATH} has an unterminated "migrations" object literal`);
  }

  return source.slice(open + 1, close);
};

const isEntry = (line: string): boolean => {
  const trimmed = line.trim();

  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("//") &&
    !trimmed.startsWith("/*") &&
    !trimmed.startsWith("*")
  );
};

const unquote = (token: string): string => QUOTED.exec(token)?.[2] ?? token;

/**
 * The key of one entry line: everything before its colon, unquoted. A shorthand
 * or otherwise malformed entry yields whatever stands there, which then fails
 * the well-formedness check by name rather than vanishing.
 */
const entryKey = (line: string): string => {
  const colon = line.indexOf(":");
  const token = colon === -1 ? line.replace(/,\s*$/, "") : line.slice(0, colon);

  return unquote(token.trim());
};

/**
 * The keys of the `migrations` record, in file order — the exact strings
 * `fromRecord` receives. Throws when the declaration is missing or its literal
 * is unterminated, because "found nothing" and "could not read it" must not
 * look alike.
 */
const parseMigrationKeys = (source: string): readonly string[] =>
  literalBody(source).split(/\r?\n/).filter(isEntry).map(entryKey);

const toMigration = (key: string): Option.Option<Migration> =>
  Option.map(Option.fromUndefinedOr(KEY_PATTERN.exec(key)?.[1]), (id) => ({
    key,
    id: Number(id),
  }));

/** The subset of keys the migrator will actually load — the rest it drops in silence. */
const loadable = (keys: readonly string[]): readonly Migration[] =>
  keys.flatMap((key) => Option.toArray(toMigration(key)));

const malformedErrors = (keys: readonly string[]): readonly string[] =>
  keys
    .filter((key) => Option.isNone(toMigration(key)))
    .map(
      (key) =>
        `Migration key "${key}" does not match <id>_<name> (for example "0004_add_budgets").\n` +
        `  fromRecord drops keys it cannot match, without an error, so this migration would never run.`
    );

const duplicateErrors = (migrations: readonly Migration[]): readonly string[] => {
  const ids = migrations.map((migration) => migration.id);

  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].map((id) => {
    const keys = migrations
      .filter((migration) => migration.id === id)
      .map((migration) => `"${migration.key}"`)
      .join(", ");

    return (
      `Migration id ${id} is claimed by more than one key: ${keys}.\n` +
      `  The migrator refuses to run at all when ids collide. Renumber all but one.`
    );
  });
};

const overflowErrors = (migrations: readonly Migration[]): readonly string[] =>
  migrations
    .filter((migration) => migration.id > MAX_MIGRATION_ID)
    .map(
      (migration) =>
        `Migration "${migration.key}" has id ${migration.id}, past the ${MAX_MIGRATION_ID} ceiling of the tracking table's integer column.\n` +
        `  Timestamp ids do not fit. Number migrations sequentially.`
    );

const skippedErrors = (
  migrations: readonly Migration[],
  base: readonly Migration[],
  baseRef: string
): readonly string[] => {
  const baseIds = new Set(base.map((migration) => migration.id));
  const baseMax = base.reduce((highest, migration) => Math.max(highest, migration.id), 0);

  return migrations
    .filter((migration) => !baseIds.has(migration.id) && migration.id <= baseMax)
    .map(
      (migration) =>
        `Migration "${migration.key}" has id ${migration.id}, which is not above ${baseMax} — the highest id already on ${baseRef}.\n` +
        `  The migrator skips every id at or below the highest one applied, silently, so this migration would never run in production.\n` +
        `  Renumber it above ${baseMax}.`
    );
};

/**
 * Every way the registry as written would fail to reach the database, given
 * what the base branch already carries. An empty result means every migration
 * on the branch will run.
 *
 * Throws rather than returning an error when a registry is present but
 * unparseable — that is a broken check, not a broken branch.
 */
const migrationIdErrors = (comparison: RegistryComparison): readonly string[] => {
  const keys = parseMigrationKeys(comparison.registry);
  const migrations = loadable(keys);
  const base = Option.match(comparison.baseRegistry, {
    onNone: (): readonly Migration[] => [],
    onSome: (registry) => loadable(parseMigrationKeys(registry)),
  });

  return [
    ...malformedErrors(keys),
    ...duplicateErrors(migrations),
    ...overflowErrors(migrations),
    ...skippedErrors(migrations, base, comparison.baseRef),
  ];
};

type GitResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

const git = (args: readonly string[]): GitResult => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    ok: result.exitCode === 0,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
};

/**
 * The base branch's registry, `None` when that branch has no registry — which
 * is a real state (a base that predates migrations) and means its highest id is
 * zero. A base ref that is not present locally is not that state: it is a check
 * that cannot do its job, and it fails loudly.
 */
const baseRegistry = (baseRef: string): Option.Option<string> => {
  if (!git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]).ok) {
    throw new Error(
      `Base ref "${baseRef}" is not available locally, so migration ids cannot be compared against it.\n` +
        `  Fetch it first: git fetch origin ${baseRef.replace(/^origin\//, "")}`
    );
  }

  // The first ref after the workspace move uses the repository path; an older
  // base branch uses the former root-relative package path.
  const path = [REPOSITORY_REGISTRY_PATH, PACKAGE_REGISTRY_PATH].find(
    (candidate) => git(["cat-file", "-e", `${baseRef}:${candidate}`]).ok
  );

  if (path === undefined) {
    return Option.none();
  }

  const shown = git(["show", `${baseRef}:${path}`]);

  if (!shown.ok) {
    throw new Error(`Could not read ${path} from ${baseRef}: ${shown.stderr}`);
  }

  return Option.some(shown.stdout);
};

const report = (errors: readonly string[], baseRef: string): string =>
  `${PACKAGE_REGISTRY_PATH} would lose migrations:\n\n${errors.join("\n\n")}\n\n` +
  `Migration ids are one global sequence (ARCHITECTURE.md §7): every key matches <id>_<name>,\n` +
  `every id is unique, and every id the branch adds is above every id already on ${baseRef} —\n` +
  `including ids that landed there after this branch was cut.\n`;

/** Reads the base branch and judges the registry. Throws when the check itself cannot run. */
const registryFailures = (source: Option.Option<string>): readonly string[] => {
  // No registry means no migration can be skipped, so there is nothing to
  // compare and no reason to need the base branch at all.
  if (Option.isNone(source)) {
    return [];
  }

  const baseRef = Bun.env.BASE_REF ?? DEFAULT_BASE_REF;
  const errors = migrationIdErrors({
    registry: source.value,
    baseRegistry: baseRegistry(baseRef),
    baseRef,
  });

  return errors.length === 0 ? [] : [report(errors, baseRef)];
};

/**
 * The same judgement, with the two "the check itself is broken" throws — an
 * unreadable registry, an unreachable base branch — turned into failures of
 * their own, so CI reports the sentence rather than a Bun stack trace.
 */
const allFailures = (source: Option.Option<string>): readonly string[] => {
  try {
    return registryFailures(source);
  } catch (cause) {
    return [`${cause instanceof Error ? cause.message : String(cause)}\n`];
  }
};

if (import.meta.main) {
  const registry = Bun.file(REGISTRY_SOURCE);
  const failures = allFailures(
    (await registry.exists()) ? Option.some(await registry.text()) : Option.none()
  );

  if (failures.length > 0) {
    process.stderr.write(failures.join("\n"));
    process.exit(1);
  }
}
