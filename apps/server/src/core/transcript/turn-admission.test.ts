import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { UserId } from "~/core/identity/reference";
import { HostedAgentSessionId } from "./reference";
import { HostedAgentSessionConsentBasis } from "./hosted-agent-session";
import { type HostedAdmissionRequest, decideHostedAdmission } from "./turn-admission";

const consent = Schema.decodeSync(HostedAgentSessionConsentBasis)({
  grantId: "f1d1a000-0000-4000-8000-000000000283",
  disclosureRevision: "onboarding-2026-01",
  disclosureSha256: "a".repeat(64),
  policyRevision: "policy-2026-01",
  policySha256: "b".repeat(64),
});
const session = {
  id: HostedAgentSessionId.make("f1d1a000-0000-4000-8000-000000000281"),
  userId: UserId.make("f1d1a000-0000-4000-8000-000000000282"),
  consentBasis: consent,
  startedAtMs: 1_000_000,
  lastTerminalAtMs: Option.some(1_000_020),
  status: "active" as const,
};
const admission = (): HostedAdmissionRequest => ({
  userId: session.userId,
  nowMs: 1_000_030,
  currentConsent: Option.some(consent),
  revoked: false,
  state: { session: Option.some(session), pendingStartedAtMs: Option.none() },
});

it("continues an active Hosted Agent Session for the same User before the fifteen-minute boundary", () => {
  expect(decideHostedAdmission(admission())).toEqual({
    _tag: "ContinueSession",
    sessionId: session.id,
  });
});

it("starts a new Hosted Agent Session at the idle boundary with the current Consent basis", () => {
  const nextConsent = Schema.decodeSync(HostedAgentSessionConsentBasis)({
    ...consent,
    policyRevision: "policy-2026-02",
    policySha256: "c".repeat(64),
  });
  expect(
    decideHostedAdmission({
      ...admission(),
      nowMs: 1_900_020,
      currentConsent: Option.some(nextConsent),
    })
  ).toEqual({ _tag: "BeginSession", consentBasis: nextConsent });
});

it("refuses revoked Consent before recovering or admitting a pending Turn", () => {
  expect(decideHostedAdmission({ ...admission(), revoked: true })).toEqual({
    _tag: "Refused",
    reason: "ConsentRequired",
  });
  expect(decideHostedAdmission({ ...admission(), currentConsent: Option.none() })).toEqual({
    _tag: "Refused",
    reason: "ConsentRequired",
  });
});

it("never admits a new Turn over pending work or another User's session", () => {
  expect(
    decideHostedAdmission({
      ...admission(),
      state: { session: Option.some(session), pendingStartedAtMs: Option.some(1_000_025) },
    })
  ).toEqual({ _tag: "RecoverPending" });
  expect(
    decideHostedAdmission({
      ...admission(),
      userId: UserId.make("f1d1a000-0000-4000-8000-000000000299"),
    })
  ).toEqual({
    _tag: "Refused",
    reason: "InvalidState",
  });
});
