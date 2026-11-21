import type { SharedBindings } from "../../storage-bootstrap/contract";
import type { BancolombiaSandboxEnvironment } from "../../bancolombia-authentication/contract";
import type { NativeAcceptanceSettings } from "../../release-isolation/contract";
import { Schema } from "effect";
import { contractDigestPattern, gitRevisionPattern } from "../contract";

export { smokePath } from "../contract";

export const smokeVersionHeader = "cloudflare-workers-version-overrides";

export const smokeProofHeader = "x-fidy-smoke-proof";

const smokeSecretPattern = /^[0-9a-f]{64}$/u;

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

export const smokeFailureHeader = "x-fidy-smoke-failure";

export const smokeIdentityHeader = "x-fidy-smoke-identity";

export const smokeCoreVersionHeader = "x-fidy-smoke-core-version";

export const smokeDiagnosticRevision = "0000000000000000000000000000000000000000";

export const SmokeIdentityEquality = Schema.String.check(Schema.isPattern(/^[01]{3}$/u));

export const SmokeFailureStage = Schema.Literals([
  "bancolombia_configuration",
  "bancolombia_signing",
  "bancolombia_discovery",
  "bancolombia_authentication",
  "bancolombia_token_lifecycle",
  "admission",
  "identity",
  "secrets",
  "schema",
  "storage",
  "coordinator",
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

export const SmokeRequest = Schema.Struct({
  verifyBancolombiaSandbox: Schema.optionalKey(Schema.Literal(true)),
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

export const SmokeCompletion = Schema.Struct({
  probeId: SmokeRequest.fields.probeId,
  coreVersionId: SmokeIdentity.fields.workerVersionId,
  executor: SmokeIdentity,
  expiresAtMs: Schema.Int,
});

export type SmokeCompletion = typeof SmokeCompletion.Type;

export type SmokeEnvironment = BancolombiaSandboxEnvironment &
  SharedBindings &
  Pick<NativeAcceptanceSettings, "NATIVE_STORAGE_ADMISSION" | "NATIVE_FIXTURE_MEMBER"> &
  Readonly<{
    SMOKE_LIMITER: RateLimit;
    SMOKE_BUCKET: R2Bucket;
    SMOKE_QUEUE: Queue;
    SMOKE_WORKFLOW: Workflow;
    SMOKE_QUEUE_NAME: string;
    SMOKE_PROOF: string;
    CF_VERSION_METADATA: { id: string };
    RELEASE_GIT_SHA: string;
    CONTRACT_DIGEST: string;
    KAPSO_API_KEY: string;
    KAPSO_WEBHOOK_SECRET: string;
    WOMPI_PRIVATE_KEY: string;
    WOMPI_INTEGRITY_SECRET: string;
  }> &
  Partial<Readonly<{ RESEND_API_KEY: string; WOMPI_EVENT_SECRET: string }>>;

export type SmokeBindings = Pick<
  SmokeEnvironment,
  | "SMOKE_LIMITER"
  | "SMOKE_BUCKET"
  | "SMOKE_QUEUE"
  | "SMOKE_WORKFLOW"
  | "SMOKE_QUEUE_NAME"
  | "SMOKE_PROOF"
  | "CF_VERSION_METADATA"
>;

export type SmokeQueueEnvironment = Pick<SmokeEnvironment, "SMOKE_QUEUE_NAME" | "SMOKE_WORKFLOW">;

export type SmokeExecutorEnvironment = Pick<
  SmokeEnvironment,
  | "SMOKE_BUCKET"
  | "SMOKE_QUEUE_NAME"
  | "SMOKE_WORKFLOW"
  | "RELEASE_GIT_SHA"
  | "CONTRACT_DIGEST"
  | "CF_VERSION_METADATA"
>;
