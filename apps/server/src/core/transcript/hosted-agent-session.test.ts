import { expect, it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";
import { HostedAgentSession, HostedAgentSessionId } from "./hosted-agent-session";

it("accepts only canonical UUID Hosted Agent Session identities", () => {
  const decode = Schema.decodeUnknownResult(HostedAgentSessionId);

  expect(Result.isSuccess(decode("f1d1a000-0000-4000-8000-000000000281"))).toBe(true);
  expect(Result.isFailure(decode("F1D1A000-0000-4000-8000-000000000281"))).toBe(true);
  expect(Result.isFailure(decode("session-281"))).toBe(true);
});

it("decodes each Hosted Agent Session lifecycle status and rejects an unknown status", () => {
  const decode = Schema.decodeUnknownResult(HostedAgentSession);
  const session = {
    id: "f1d1a000-0000-4000-8000-000000000281",
    subjectUserId: "f1d1a000-0000-4000-8000-000000000282",
    consentBasis: {
      grantId: "f1d1a000-0000-4000-8000-000000000283",
      disclosureRevision: "onboarding-2026-01",
      disclosureSha256: "a".repeat(64),
      policyRevision: "policy-2026-01",
      policySha256: "b".repeat(64),
    },
    startedAt: "2026-08-01T12:00:00Z",
    lastTerminalTurnAt: Option.none(),
  };

  for (const status of ["active", "idle-ended", "revoked"] as const) {
    expect(Result.isSuccess(decode({ ...session, status }))).toBe(true);
  }

  expect(Result.isFailure(decode({ ...session, status: "unknown" }))).toBe(true);
});
