import { Effect, Option } from "effect";
import type { ErasureDecision } from "../../apps/server/src/core/erasure/contract";
import {
  type ErasureHandoff,
  RegisterFailure,
  type TitularCase,
} from "../titular-requests/contract";

/** Prepares an operator command from the recorded handoff. This verifies reference consistency, never the underlying identity proof or the server's fresh User intent. */
export const prepareErasureReview = (
  input: Readonly<{ case: TitularCase; decision: ErasureDecision }>
): Effect.Effect<Readonly<{ action: "Review"; decision: ErasureDecision }>, RegisterFailure> => {
  const handoff = input.case.erasureHandoff;
  if (input.case.kind !== "Erasure" || input.case.requester !== "User" || Option.isNone(handoff)) {
    return Effect.fail(new RegisterFailure({ reason: "InvalidTransition" }));
  }
  const decision = input.decision;
  if (!matchesHandoff({ ...input, handoff: handoff.value })) {
    return Effect.fail(new RegisterFailure({ reason: "InvalidTransition" }));
  }
  return Effect.succeed({ action: "Review", decision });
};

const sameWithdrawal = (
  left: ErasureDecision["withdrawal"],
  right: ErasureDecision["withdrawal"]
): boolean =>
  left.status === right.status &&
  (left.status !== "Recorded" ||
    (right.status === "Recorded" && left.reference === right.reference));

const matchesHandoff = (
  input: Readonly<{
    case: TitularCase;
    decision: ErasureDecision;
    handoff: typeof ErasureHandoff.Type;
  }>
): boolean => {
  const { decision, handoff } = input;
  return !(
    input.case.caseId !== decision.caseRef ||
    !Option.contains(decision.authorityRef)(input.case.verificationRef) ||
    handoff.authorityRef !== decision.authorityRef ||
    handoff.scopeRef !== decision.scopeRef ||
    handoff.evidenceRef !== decision.handoffRef ||
    !sameWithdrawal(handoff.withdrawal, decision.withdrawal)
  );
};
