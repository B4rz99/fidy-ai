import {
  type HostedAdmissionRequest,
  HostedAgentSessionConsentBasis,
  HostedAgentSessionId,
} from "./contract";
import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { UserId } from "~/core/identity/contract";
import { decideHostedAdmission } from "./operations";

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
  lastActivityAtMs: Option.some(1_000_020),
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

it("refuses invalid clocks and inconsistent retained session activity before granting admission", () => {
  for (const nowMs of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(decideHostedAdmission({ ...admission(), nowMs })).toEqual({
      _tag: "Refused",
      reason: "InvalidState",
    });
  }
  expect(
    decideHostedAdmission({
      ...admission(),
      state: { session: Option.none(), pendingStartedAtMs: Option.some(1_000_025) },
    })
  ).toEqual({ _tag: "Refused", reason: "InvalidState" });
  for (const timestamp of [999_999, 1_000_031]) {
    for (const state of [
      {
        session: Option.some({ ...session, lastActivityAtMs: Option.some(timestamp) }),
        pendingStartedAtMs: Option.none(),
      },
      { session: Option.some(session), pendingStartedAtMs: Option.some(timestamp) },
    ]) {
      expect(decideHostedAdmission({ ...admission(), state })).toEqual({
        _tag: "Refused",
        reason: "InvalidState",
      });
    }
  }
  expect(
    decideHostedAdmission({
      ...admission(),
      state: {
        session: Option.some({ ...session, startedAtMs: 1_000_031 }),
        pendingStartedAtMs: Option.none(),
      },
    })
  ).toEqual({ _tag: "Refused", reason: "InvalidState" });
});

it("uses session opening until terminal activity exists and accepts activity exactly at the clock bounds", () => {
  const fresh = { ...session, lastActivityAtMs: Option.none() };
  const request = {
    ...admission(),
    state: { session: Option.some(fresh), pendingStartedAtMs: Option.none() },
  };
  expect(decideHostedAdmission({ ...request, nowMs: 1_899_999 })).toEqual({
    _tag: "ContinueSession",
    sessionId: session.id,
  });
  expect(decideHostedAdmission({ ...request, nowMs: 1_900_000 })).toEqual({
    _tag: "BeginSession",
    consentBasis: consent,
  });
  expect(
    decideHostedAdmission({
      ...admission(),
      state: { session: Option.none(), pendingStartedAtMs: Option.none() },
    })
  ).toEqual({ _tag: "BeginSession", consentBasis: consent });
  for (const timestamp of [session.startedAtMs, admission().nowMs]) {
    expect(
      decideHostedAdmission({
        ...admission(),
        state: {
          session: Option.some({ ...session, lastActivityAtMs: Option.some(timestamp) }),
          pendingStartedAtMs: Option.none(),
        },
      })
    ).toEqual({ _tag: "ContinueSession", sessionId: session.id });
    expect(
      decideHostedAdmission({
        ...admission(),
        state: { session: Option.some(session), pendingStartedAtMs: Option.some(timestamp) },
      })
    ).toEqual({ _tag: "RecoverPending" });
  }
});

it("validates an initial clock even without a retained session and permits the zero epoch", () => {
  const state = {
    session: Option.none<typeof session>(),
    pendingStartedAtMs: Option.none<number>(),
  };
  expect(decideHostedAdmission({ ...admission(), state, nowMs: -1 })).toEqual({
    _tag: "Refused",
    reason: "InvalidState",
  });
  expect(decideHostedAdmission({ ...admission(), state, nowMs: 0 })).toEqual({
    _tag: "BeginSession",
    consentBasis: consent,
  });
  expect(
    decideHostedAdmission({
      ...admission(),
      nowMs: session.startedAtMs,
      state: {
        session: Option.some({ ...session, lastActivityAtMs: Option.none() }),
        pendingStartedAtMs: Option.none(),
      },
    })
  ).toEqual({ _tag: "ContinueSession", sessionId: session.id });
});

it("begins a new session after an explicitly ended one even when its activity is recent", () => {
  expect(
    decideHostedAdmission({
      ...admission(),
      state: {
        session: Option.some({ ...session, status: "idle-ended" }),
        pendingStartedAtMs: Option.none(),
      },
    })
  ).toEqual({ _tag: "BeginSession", consentBasis: consent });
});

it("refuses a future session start even when no activity or Pending Turn has been recorded", () => {
  const request = admission();
  expect(
    decideHostedAdmission({
      ...request,
      nowMs: session.startedAtMs - 1,
      state: {
        session: Option.some({ ...session, lastActivityAtMs: Option.none() }),
        pendingStartedAtMs: Option.none(),
      },
    })
  ).toEqual({ _tag: "Refused", reason: "InvalidState" });
});
