import { Option } from "effect";
import { HostedAdmissionDecision, type HostedAdmissionRequest } from "./contract";

const millisecondsPerSecond = 1_000;

const secondsPerMinute = 60;

const idleMinutes = 15;

export const hostedSessionIdleMilliseconds = idleMinutes * secondsPerMinute * millisecondsPerSecond;

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

export const decideHostedAdmission = (request: HostedAdmissionRequest): HostedAdmissionDecision => {
  if (invalidState(request)) return HostedAdmissionDecision.Refused({ reason: "InvalidState" });

  if (request.revoked || Option.isNone(request.currentConsent)) {
    return HostedAdmissionDecision.Refused({ reason: "ConsentRequired" });
  }

  if (Option.isSome(request.state.pendingStartedAtMs)) {
    return HostedAdmissionDecision.RecoverPending();
  }

  if (Option.isSome(request.state.session)) {
    const session = request.state.session.value;
    const lastActivity = Option.getOrElse(session.lastActivityAtMs, () => session.startedAtMs);

    if (
      session.status === "active" &&
      request.nowMs - lastActivity < hostedSessionIdleMilliseconds
    ) {
      return HostedAdmissionDecision.ContinueSession({ sessionId: session.id });
    }
  }

  return HostedAdmissionDecision.BeginSession({ consentBasis: request.currentConsent.value });
};

export const defaultCompactionTriggerTokens = 100_000;

export const defaultCompactionMaximumTokens = 15_000;

export const compactionEntryTrigger = 80;

export const terminalPrefixCursor = (
  entries: ReadonlyArray<
    Readonly<{ sequence: number; status: "pending" | "completed" | "failed" | "interrupted" }>
  >
): Option.Option<number> => {
  const pending = entries.findIndex((entry) => entry.status === "pending");

  return pending === 0
    ? Option.none()
    : Option.fromNullishOr(entries.at(pending < 0 ? -1 : pending - 1)?.sequence);
};

export const shouldCompactConversation = ({
  entryCount,
  tokenCount,
}: Readonly<{ entryCount: number; tokenCount: number }>): boolean =>
  entryCount >= compactionEntryTrigger || tokenCount >= defaultCompactionTriggerTokens;
