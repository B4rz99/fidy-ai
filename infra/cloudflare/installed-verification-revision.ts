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

/** Keep the checked-out verifier on protected trunk and prove all other files match the installed source. */
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
  if (paths.split("\0").some((path) => path !== "" && !isVerificationFile(path))) {
    return yield* Effect.fail(
      Error("Installed release inputs differ from the verification checkout")
    );
  }
  return requested;
});
