import { Option } from "effect";
import type { UserId } from "~/core/identity/reference";
import type { HostedAgentSessionConsentBasis } from "./hosted-agent-session";
import type { HostedAgentSessionId } from "./reference";

/** The latest durable session and Turn facts read while holding one User's coordination lock. */
export type HostedAdmissionState = Readonly<{
  session: Option.Option<
    Readonly<{
      id: HostedAgentSessionId;
      userId: UserId;
      consentBasis: HostedAgentSessionConsentBasis;
      startedAtMs: number;
      lastActivityAtMs: Option.Option<number>;
      status: "active" | "idle-ended" | "revoked";
    }>
  >;
  pendingStartedAtMs: Option.Option<number>;
}>;

/** A current onboarding grant is required for every admission, even in an existing session. */
export type HostedAdmissionRequest = Readonly<{
  userId: UserId;
  nowMs: number;
  currentConsent: Option.Option<HostedAgentSessionConsentBasis>;
  revoked: boolean;
  state: HostedAdmissionState;
}>;

/** A pending Turn must be recovered as Interrupted before a new Turn can be admitted. */
export type HostedAdmissionDecision =
  | Readonly<{ _tag: "Refused"; reason: "ConsentRequired" | "InvalidState" }>
  | Readonly<{ _tag: "RecoverPending" }>
  | Readonly<{ _tag: "ContinueSession"; sessionId: HostedAgentSessionId }>
  | Readonly<{ _tag: "BeginSession"; consentBasis: HostedAgentSessionConsentBasis }>;

const millisecondsPerSecond = 1_000;
const secondsPerMinute = 60;
const idleMinutes = 15;
const idleMilliseconds = idleMinutes * secondsPerMinute * millisecondsPerSecond;

const invalidState = ({ userId, nowMs, state }: HostedAdmissionRequest): boolean => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return true;
  if (Option.isNone(state.session)) return Option.isSome(state.pendingStartedAtMs);
  const session = state.session.value;
  const invalidInstant = (instant: Option.Option<number>): boolean =>
    Option.exists(instant, (value) => value < session.startedAtMs || value > nowMs);
  return (
    session.userId !== userId ||
    session.startedAtMs > nowMs ||
    invalidInstant(session.lastActivityAtMs) ||
    invalidInstant(state.pendingStartedAtMs)
  );
};

/**
 * Decide session admission under a single User's coordination lock. A Pending Turn is never an
 * unlimited session extension: after recovery the next decision uses the latest terminal instant.
 * The caller must durably perform recovery or session creation before retrying admission.
 */
export const decideHostedAdmission = (request: HostedAdmissionRequest): HostedAdmissionDecision => {
  if (invalidState(request)) return { _tag: "Refused", reason: "InvalidState" };
  if (request.revoked || Option.isNone(request.currentConsent)) {
    return { _tag: "Refused", reason: "ConsentRequired" };
  }
  if (Option.isSome(request.state.pendingStartedAtMs)) return { _tag: "RecoverPending" };
  if (Option.isSome(request.state.session)) {
    const session = request.state.session.value;
    const lastActivity = Option.getOrElse(session.lastActivityAtMs, () => session.startedAtMs);
    if (session.status === "active" && request.nowMs - lastActivity < idleMilliseconds) {
      return { _tag: "ContinueSession", sessionId: session.id };
    }
  }
  return { _tag: "BeginSession", consentBasis: request.currentConsent.value };
};
