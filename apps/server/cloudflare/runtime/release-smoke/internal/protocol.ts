import { Schema } from "effect";
import { SmokeIdentity, SmokeRequest } from "../contract";

export const SmokeWork = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  probeId: SmokeRequest.fields.probeId,
  gitRevision: SmokeIdentity.fields.gitRevision,
});
export type SmokeWork = typeof SmokeWork.Type;
