#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Effect, Option, Schema } from "effect";

const effectPrereleaseVersion = /^4\.0\.0-(?:beta|rc)\.\d+$/u;
const PackageEntry = Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Unknown]);
const Lockfile = Schema.Struct({
  packages: Schema.Record(Schema.String, PackageEntry),
  workspaces: Schema.Record(Schema.String, Schema.Unknown),
});
const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

type Finding = {
  readonly packageName: string;
  readonly version: string;
  readonly location: string;
};

const repositoryRoot = (): string => {
  const args = Bun.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  if (rootIndex === -1) return Bun.fileURLToPath(new URL("..", import.meta.url));

  const selected = Option.fromUndefinedOr(args[rootIndex + 1]);
  if (Option.isNone(selected)) {
    process.stderr.write("--root requires a repository path\n");
    process.exit(2);
  }
  return selected.value.replace(/\/$/u, "");
};

const isPackageFamily = (name: string, family: string): boolean =>
  name === family || name.startsWith(`${family}-`);

const isCoordinatedEffectPackage = (name: string): boolean =>
  name === "effect" ||
  isPackageFamily(name, "@effect/platform") ||
  isPackageFamily(name, "@effect/ai") ||
  isPackageFamily(name, "@effect/sql") ||
  name === "@effect/vitest" ||
  name === "@effect/atom-react";

const readJson = <A>(schema: Schema.Codec<A, unknown>, path: string): Effect.Effect<A> =>
  Effect.map(
    Effect.promise(() => Bun.file(path).json()),
    Schema.decodeUnknownSync(schema)
  );

const readLockfile = (path: string): Effect.Effect<typeof Lockfile.Type> =>
  Effect.map(
    Effect.promise(() => Bun.file(path).text()),
    (text) => Schema.decodeUnknownSync(Lockfile)(Bun.JSONC.parse(text))
  );

const manifestPath = (root: string, workspace: string): string =>
  workspace === "" ? `${root}/package.json` : `${root}/${workspace}/package.json`;

const directPins = (
  manifests: ReadonlyArray<Readonly<{ path: string; value: typeof Manifest.Type }>>
): ReadonlyArray<Finding> =>
  manifests.flatMap(({ path, value }) =>
    [...Object.entries(value.dependencies ?? {}), ...Object.entries(value.devDependencies ?? {})]
      .filter(([name]) => isCoordinatedEffectPackage(name))
      .map(([packageName, version]) => ({ packageName, version, location: path }))
  );

type PackageIdentity = {
  readonly packageName: string;
  readonly version: string;
};

const packageIdentity = (resolved: string): Option.Option<PackageIdentity> => {
  const versionSeparator = resolved.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === resolved.length - 1) return Option.none();
  return Option.some({
    packageName: resolved.slice(0, versionSeparator),
    version: resolved.slice(versionSeparator + 1),
  });
};

const lockedPackages = (lockfile: typeof Lockfile.Type): ReadonlyArray<Finding> =>
  Object.values(lockfile.packages).flatMap((entry) =>
    Option.match(packageIdentity(entry[0]), {
      onNone: () => [],
      onSome: ({ packageName, version }) =>
        isCoordinatedEffectPackage(packageName)
          ? [{ packageName, version, location: "bun.lock" }]
          : [],
    })
  );

const mismatches = (
  packages: ReadonlyArray<Finding>,
  selectedVersion: string
): ReadonlyArray<Finding> => packages.filter(({ version }) => version !== selectedVersion);

const missingOverrides = ({
  locked,
  direct,
  overrides,
  selectedVersion,
}: {
  readonly locked: ReadonlyArray<Finding>;
  readonly direct: ReadonlyArray<Finding>;
  readonly overrides: Readonly<Record<string, string>>;
  readonly selectedVersion: string;
}): ReadonlyArray<Finding> => {
  const directlySelected = new Set(direct.map(({ packageName }) => packageName));
  return locked.flatMap(({ packageName }) => {
    if (!isPackageFamily(packageName, "@effect/platform") || directlySelected.has(packageName)) {
      return [];
    }
    const override = overrides[packageName];
    return override === selectedVersion
      ? []
      : [
          {
            packageName: `${packageName} override`,
            version: override ?? "missing",
            location: "package.json",
          },
        ];
  });
};

const main = Effect.gen(function* () {
  const root = repositoryRoot();
  const lockfile = yield* readLockfile(`${root}/bun.lock`);
  const manifests = yield* Effect.forEach(Object.keys(lockfile.workspaces), (workspace) => {
    const path = manifestPath(root, workspace);
    return Effect.map(readJson(Manifest, path), (value) => ({ path, value }));
  });
  const direct = directPins(manifests);
  const selected = direct.find(({ packageName }) => packageName === "effect");
  if (selected === undefined || !effectPrereleaseVersion.test(selected.version)) {
    const finding = Option.match(Option.fromUndefinedOr(selected), {
      onNone: () => ({ version: "missing", location: "workspace manifests" }),
      onSome: ({ version, location }) => ({ version, location }),
    });
    process.stderr.write(
      `Effect dependency family check failed:\n- effect: ${finding.version} (${finding.location})\n`
    );
    return yield* Effect.sync(() => process.exit(1));
  }

  const locked = lockedPackages(lockfile);
  const rootOverrides = manifests.find(({ path }) => path === `${root}/package.json`)?.value
    .overrides;
  const findings = [
    ...mismatches(direct, selected.version),
    ...mismatches(locked, selected.version),
    ...missingOverrides({
      locked,
      direct,
      overrides: rootOverrides ?? {},
      selectedVersion: selected.version,
    }),
  ];

  if (findings.length > 0) {
    process.stderr.write(
      `Effect dependency family check failed; selected ${selected.version}:\n${findings
        .map(({ packageName, version, location }) => `- ${packageName}: ${version} (${location})`)
        .join("\n")}\n`
    );
    return yield* Effect.sync(() => process.exit(1));
  }

  yield* Effect.sync(() =>
    process.stdout.write(
      `Effect dependency family: ${selected.version}; ${direct.length} direct and ${locked.length} locked packages agree.\n`
    )
  );
});

BunRuntime.runMain(main);
