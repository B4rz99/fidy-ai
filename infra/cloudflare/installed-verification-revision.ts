import { Effect, Schema } from "effect";

const commit = Schema.is(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)));
const verifierFiles = new Set([
  ".github/workflows/native-storage-release.yml",
  "docs/operations/production-releases.md",
  "infra/cloudflare/installed-verification-revision.ts",
  "infra/cloudflare/native-deployed-edge.ts",
  "infra/cloudflare/native-deployed-graph.ts",
  "infra/cloudflare/native-deployed-web.ts",
  "infra/cloudflare/native-storage-release.ts",
  "infra/cloudflare/production-release.ts",
  "infra/cloudflare/verify-edge-policy.ts",
]);
const isVerificationFile = (path: string): boolean =>
  verifierFiles.has(path) || /^infra\/cloudflare\/[^/]+\.test\.ts$/u.test(path);

/** Keep the checked-out verifier on protected trunk and prove all other files match the installed source. */
export const verificationRevision = Effect.fn(function* (
  trunk: string,
  requested: string,
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, Error>
) {
  if (requested === "" || requested === trunk) return trunk;
  if (!commit(trunk) || !commit(requested)) {
    return yield* Effect.fail(Error("Expected a full Git commit"));
  }
  yield* git(["merge-base", "--is-ancestor", requested, trunk]);
  const paths = yield* git(["diff", "--name-only", "--no-renames", "-z", requested, trunk, "--"]);
  if (paths.split("\0").some((path) => path !== "" && !isVerificationFile(path))) {
    return yield* Effect.fail(Error("Installed release inputs differ from the verification checkout"));
  }
  return requested;
});
