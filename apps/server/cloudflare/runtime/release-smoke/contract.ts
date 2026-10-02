import { Schema } from "effect";
import { contractDigestPattern, gitRevisionPattern } from "../contract";

export const smokePath = "/internal/release-smoke";
export const smokeVersionHeader = "cloudflare-workers-version-overrides";
export const smokeProofHeader = "x-fidy-smoke-proof";
export const smokeFailureHeader = "x-fidy-smoke-failure";
export const smokeIdentityHeader = "x-fidy-smoke-identity";
export const smokeCoreVersionHeader = "x-fidy-smoke-core-version";
/** Reserved invalid release revision: diagnostic POSTs always stop before admission. */
export const smokeDiagnosticRevision = "0000000000000000000000000000000000000000";
/** Equality bits for Core version, revision, and digest; no observed values cross this boundary. */
export const SmokeIdentityEquality = Schema.String.check(Schema.isPattern(/^[01]{3}$/u));
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

/** Native synthetic release proof bindings; these never grant User authority. */
export type SmokeEnvironment = Readonly<{
  DB: D1Database;
  SMOKE_BUCKET: R2Bucket;
  SMOKE_QUEUE: Queue;
  SMOKE_WORKFLOW: Workflow;
  SMOKE_QUEUE_NAME: string;
  USER_TRANSACTION_COORDINATOR: { getByName: (name: string) => Pick<Fetcher, "fetch"> };
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

/** The native bindings the existing readiness gate requires before any synthetic smoke path. */
export type SmokeBindings = Pick<
  SmokeEnvironment,
  | "SMOKE_BUCKET"
  | "SMOKE_QUEUE"
  | "SMOKE_WORKFLOW"
  | "SMOKE_QUEUE_NAME"
  | "SMOKE_PROOF"
  | "CF_VERSION_METADATA"
>;

/** Synthetic Queue handoff has no provider, model, or User-data authority. */
export type SmokeQueueEnvironment = Pick<
  SmokeEnvironment,
  "DB" | "RELEASE_GIT_SHA" | "SMOKE_QUEUE_NAME" | "SMOKE_WORKFLOW"
>;
