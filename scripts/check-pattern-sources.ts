#!/usr/bin/env bun

import { Effect, Schema } from "effect";

const PackagePin = Schema.Struct({
  name: Schema.String,
  manifest: Schema.String,
  version: Schema.String,
});
const Source = Schema.Struct({
  repository: Schema.String,
  verifiedOn: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  snapshot: Schema.Struct({
    manifest: Schema.String,
    version: Schema.String,
    revision: Schema.String,
    revisionKind: Schema.Literals(["upstream-commit", "repository-tree"]),
    provenance: Schema.String,
    status: Schema.Literals(["historical", "matching-version"]),
  }),
  packages: Schema.NonEmptyArray(PackagePin),
  sourcePaths: Schema.NonEmptyArray(Schema.String),
  patches: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
});
const Sources = Schema.Struct({
  effect: Source,
  alchemy: Source,
  react: Source,
  "dnd-kit": Source,
});
const PackageManifest = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const args = Bun.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--root")) {
  process.stderr.write("Usage: bun scripts/check-pattern-sources.ts [--root <repository>]\n");
  process.exit(2);
}
const root = args[1] ?? Bun.fileURLToPath(new URL("..", import.meta.url));
const readText = (path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => Bun.file(`${root}/${path}`).text()).pipe(Effect.orDie);
const readManifest = (path: string): Effect.Effect<typeof PackageManifest.Type> =>
  readText(path).pipe(Effect.map(Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest))));

const checkSnapshot = (
  name: string,
  source: typeof Source.Type
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const findings: Array<string> = [];
    const snapshot = yield* readManifest(source.snapshot.manifest);
    if (snapshot.version !== source.snapshot.version) {
      findings.push(`${name}: snapshot version changed; review ${source.snapshot.manifest}`);
    }
    if (
      source.snapshot.status === "matching-version" &&
      source.snapshot.version !== source.packages[0].version
    ) {
      findings.push(`${name}: differing snapshot must be marked historical`);
    }
    for (const path of source.sourcePaths) {
      if (
        !(yield* Effect.tryPromise(() => Bun.file(`${root}/${path}`).exists()).pipe(Effect.orDie))
      ) {
        findings.push(`${name}: missing source path ${path}`);
      }
    }
    return findings;
  });

const checkPin = (
  name: string,
  pin: typeof PackagePin.Type
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const manifest = yield* readManifest(pin.manifest);
    const selected = manifest.dependencies?.[pin.name] ?? manifest.devDependencies?.[pin.name];
    return selected === pin.version
      ? []
      : [`${name}: ${pin.name} changed from ${pin.version} to ${selected ?? "missing"}`];
  });

const checkPatches = (
  name: string,
  source: typeof Source.Type
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const rootManifest = yield* readManifest("package.json");
    const selectedPatches = source.packages.flatMap((pin) => {
      const path = rootManifest.patchedDependencies?.[`${pin.name}@${pin.version}`];
      return path === undefined ? [] : [path];
    });
    const findings = selectedPatches
      .filter((path) => !source.patches.some((patch) => patch.path === path))
      .map((path) => `${name}: unreviewed selected patch ${path}`);
    for (const patch of source.patches) {
      if (!selectedPatches.includes(patch.path)) {
        findings.push(`${name}: patch is no longer selected: ${patch.path}`);
      }
      const content = yield* readText(patch.path);
      if (new Bun.CryptoHasher("sha256").update(content).digest("hex") !== patch.sha256) {
        findings.push(`${name}: patch content changed: ${patch.path}`);
      }
    }
    return findings;
  });

const checkSource = (
  name: string,
  source: typeof Source.Type
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const snapshotFindings = yield* checkSnapshot(name, source);
    const pinFindings = yield* Effect.forEach(source.packages, (pin) => checkPin(name, pin));
    const patchFindings = yield* checkPatches(name, source);
    return [...snapshotFindings, ...pinFindings.flat(), ...patchFindings];
  });

const localFileTargets = (content: string): ReadonlyArray<string> =>
  [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.split("#")[0] ?? "")
    .filter((target) => target.length > 0)
    .filter((target) => !/^[a-z][a-z\d+.-]*:/iu.test(target));

const checkPatternLinks = Effect.gen(function* () {
  const findings: Array<string> = [];
  const index = yield* readText(".patterns/INDEX.md");
  const files = [...new Bun.Glob("*.md").scanSync(`${root}/.patterns`)];
  for (const file of files) {
    if (file !== "INDEX.md" && !index.includes(`](${file})`)) {
      findings.push(`${file}: missing INDEX.md entry`);
    }
    const content = yield* readText(`.patterns/${file}`);
    for (const target of localFileTargets(content)) {
      const path = `${root}/.patterns/${target}`;
      if (!(yield* Effect.tryPromise(() => Bun.file(path).exists()).pipe(Effect.orDie))) {
        findings.push(`${file}: broken local link ${target}`);
      }
    }
  }
  return findings;
});

const main = Effect.gen(function* () {
  const sources = yield* readText(".patterns/sources.json").pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Sources)))
  );
  const findings = (yield* Effect.forEach(Object.entries(sources), ([name, source]) =>
    checkSource(name, source)
  )).flat();
  findings.push(...(yield* checkPatternLinks));
  if (findings.length > 0) {
    process.stderr.write(
      `Pattern source check failed:\n${findings.map((line) => `- ${line}`).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "Pattern sources: four snapshots, selected pins, patches and local links agree.\n"
  );
});

Effect.runPromise(main).catch((error: unknown) => {
  process.stderr.write(`Pattern source check failed: ${String(error)}\n`);
  process.exitCode = 1;
});
