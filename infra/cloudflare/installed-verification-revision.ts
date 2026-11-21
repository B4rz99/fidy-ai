import { Effect, Schema } from "effect";

const commit = Schema.is(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)));

const verifierFiles = new Set([
  ".github/workflows/native-storage-release.yml",
  ".github/workflows/native-fleet-pilot-check.yml",
  "docs/operations/production-releases.md",
  "docs/adr/0041-per-user-durable-object-storage-direction.md",
  "infra/cloudflare/native-ten-fleet.ts",
  "infra/cloudflare/native-ten-release.ts",
  "scripts/infra-performance/deployed-fleet/ten-source.sh",
  "scripts/infra-performance/deployed-fleet/ten.py",
  "scripts/infra-performance/deployed-fleet/test_ten.py",
  "infra/cloudflare/installed-verification-revision.ts",
  "infra/cloudflare/native-fleet-pilot.ts",
  "infra/cloudflare/native-deployed-edge.ts",
  "infra/cloudflare/native-deployed-graph.ts",
  "infra/cloudflare/native-deployed-web.ts",
  "infra/cloudflare/native-erasure.ts",
  "infra/cloudflare/native-erasure-continuation.ts",
  "infra/cloudflare/native-acceptance.ts",
  "infra/cloudflare/native-storage-release.ts",
  "infra/cloudflare/production-release.ts",
  "infra/cloudflare/verify-edge-policy.ts",
  "scripts/infra-performance/deployed-fleet/observations.py",
  "scripts/infra-performance/deployed-fleet/pilot.py",
  "scripts/infra-performance/deployed-fleet/test_pilot.py",
]);

const isVerificationFile = (path: string): boolean =>
  verifierFiles.has(path) || /^infra\/cloudflare\/[^/]+\.test\.ts$/u.test(path);

const typeManifests = ["apps/server/package.json", "bun.lock", "infra/cloudflare/package.json"];

const reviewedTypesDigest = "cecb1320af85336bd11b1c8cd052a65a0425d49d60919cfdc9e7d81b1d0310d2";

type GitRead = (args: ReadonlyArray<string>) => Effect.Effect<string, Error>;

const reviewedTypeRefresh = Effect.fn(function* (
  git: GitRead,
  refs: ReadonlyArray<string>,
  changed: ReadonlyArray<string>
) {
  if (
    changed.length !== typeManifests.length ||
    !changed.every((path) => typeManifests.includes(path))
  ) {
    return false;
  }

  const raw = yield* git([
    "diff",
    "--no-color",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    ...refs,
    "--",
    ...typeManifests,
  ]);

  return new Bun.CryptoHasher("sha256").update(raw.trimEnd()).digest("hex") === reviewedTypesDigest;
});

export const verificationRevision = Effect.fn(function* (
  trunk: string,
  requested: string,
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, Error>
) {
  if (!commit(trunk) || (requested !== "" && !commit(requested))) {
    return yield* Effect.fail(Error("Expected a full Git commit"));
  }

  if (requested === "" || requested === trunk) return trunk;
  yield* git(["merge-base", "--is-ancestor", requested, trunk]);
  const paths = yield* git(["diff", "--name-only", "--no-renames", "-z", requested, trunk, "--"]);
  const changed = paths.split("\0").filter((path) => path !== "" && !isVerificationFile(path));

  if (changed.length === 0) return requested;

  if (yield* reviewedTypeRefresh(git, [requested, trunk], changed)) return requested;

  return yield* Effect.fail(
    Error("Installed release inputs differ from the verification checkout")
  );
});
