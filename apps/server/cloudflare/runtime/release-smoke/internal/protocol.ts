import { Schema } from "effect";
import { SmokeIdentity, SmokeRequest } from "../contract";

export const SmokeWork = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  probeId: SmokeRequest.fields.probeId,
  gitRevision: SmokeIdentity.fields.gitRevision,
  contractDigest: SmokeIdentity.fields.contractDigest,
  coreVersionId: SmokeIdentity.fields.workerVersionId,
  expiresAtMs: Schema.Int,
});
export type SmokeWork = typeof SmokeWork.Type;

export const smokeLifetimeMs = 300_000;
export const smokeExecutionId = (
  work: Readonly<{ probeId: string; coreVersionId: string }>
): string => `smoke-v2-${work.coreVersionId}-${work.probeId}`;
