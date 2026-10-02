import { Option } from "effect";
import type { HostedAdmissionDecision, HostedAdmissionRequest } from "./contract";

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

/** Production exact-Transcript token threshold that requests Compaction. */
export const defaultCompactionTriggerTokens = 100_000;

/** Production maximum for one generated CompactedConversation replacement. */
export const defaultCompactionMaximumTokens = 15_000;

/** Compaction also precedes the exact-entry capacity of a long, low-token Hosted Agent Session. */
export const compactionEntryTrigger = 80;

/** The last complete terminal Turn in the contiguous retained prefix, never a Pending User entry. */
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

/** Decide when exact retained continuity should be replaced before the next hosted Turn. */
export const shouldCompactConversation = ({
  entryCount,
  tokenCount,
}: Readonly<{ entryCount: number; tokenCount: number }>): boolean =>
  entryCount >= compactionEntryTrigger || tokenCount >= defaultCompactionTriggerTokens;
