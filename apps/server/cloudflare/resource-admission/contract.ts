import { Data, Schema } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import type { WebSessionId } from "../../src/core/web-session/contract";

export class ResourceAdmissionRefused extends Data.TaggedError("ResourceAdmissionRefused")<{
  readonly reason: "resource_limit";
}> {}

export class ResourceAdmissionUnavailable extends Data.TaggedError("ResourceAdmissionUnavailable")<{
  readonly reason: "authority_unavailable";
}> {}

export type ResourceAdmissionEventOwner =
  | Readonly<{ kind: "user"; userId: UserId }>
  | Readonly<{ kind: "web_session"; userId: UserId; sessionId: WebSessionId }>;

export const ProviderSpend = Schema.Struct({
  phase: Schema.Literals(["model", "reminderGeneration", "reminderSend"]),
  units: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const providerAllowanceUrl = "https://directory.invalid/provider-allowance";

export const providerAllowanceSchema = [
  "CREATE TABLE provider_spend_attempts(phase TEXT NOT NULL,at_ms INTEGER NOT NULL,units INTEGER NOT NULL CHECK(units>=0)) STRICT",
  "CREATE INDEX provider_spend_by_phase ON provider_spend_attempts(phase,at_ms,units)",
  "CREATE INDEX provider_spend_expiry ON provider_spend_attempts(at_ms)",
] as const;
