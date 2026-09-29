import { Schema } from "effect";
import { contractDigestPattern, gitRevisionPattern } from "./release-identity";

export const smokePath = "/internal/release-smoke";
export const smokeVersionHeader = "cloudflare-workers-version-overrides";
export const smokeProofHeader = "x-fidy-smoke-proof";
export const smokeFailureHeader = "x-fidy-smoke-failure";
/** Only closed stages cross the proof-admitted smoke boundary, never foreign error text. */
export const SmokeFailureStage = Schema.Literals([
  "identity",
  "secrets",
  "schema",
  "storage",
  "coordinator",
  "admission",
  "claim",
  "publication",
  "probe_read",
  "probe_state",
  "platform",
  "configuration",
  "public_forwarding",
  "public_response",
  "core_response",
]);
export type SmokeFailureStage = typeof SmokeFailureStage.Type;

export const SmokeIdentity = Schema.Struct({
  gitRevision: Schema.String.check(Schema.isPattern(gitRevisionPattern)),
  contractDigest: Schema.String.check(Schema.isPattern(contractDigestPattern)),
  workerVersionId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  ),
});
export type SmokeIdentity = typeof SmokeIdentity.Type;

/** The runner must compare observed Worker identities with its upload receipts, never trust a 2xx alone. */
export const verifySmokeIdentity = ({
  expected,
  observed,
}: Readonly<{ expected: SmokeIdentity; observed: SmokeIdentity }>): boolean =>
  expected.gitRevision === observed.gitRevision &&
  expected.contractDigest === observed.contractDigest &&
  expected.workerVersionId === observed.workerVersionId;

const smokeSecretPattern = /^[0-9a-f]{64}$/u;

/** A separate, randomly provisioned deployment-runner credential, never a User or provider grant. */
export const smokeProofAccepted = ({
  request,
  secret,
}: Readonly<{ request: Request; secret: string }>): boolean => {
  const offered = request.headers.get(smokeProofHeader) ?? "";
  if (!smokeSecretPattern.test(secret) || !smokeSecretPattern.test(offered)) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index++) {
    difference |= secret.charCodeAt(index) ^ offered.charCodeAt(index);
  }
  return difference === 0;
};

export const SmokeRequest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  probeId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  expectedPublicVersionId: SmokeIdentity.fields.workerVersionId,
  expectedCoreVersionId: SmokeIdentity.fields.workerVersionId,
  expectedGitRevision: SmokeIdentity.fields.gitRevision,
  expectedContractDigest: SmokeIdentity.fields.contractDigest,
});
export type SmokeRequest = typeof SmokeRequest.Type;

export const smokeManifest = { protocolVersion: 1, asyncWorkVersion: 1 } as const;
export const SmokeManifest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  asyncWorkVersion: Schema.Literal(1),
});
export const SmokeResponse = Schema.Struct({
  status: Schema.Literals(["pending", "passed"]),
  core: SmokeIdentity,
  manifest: SmokeManifest,
});
