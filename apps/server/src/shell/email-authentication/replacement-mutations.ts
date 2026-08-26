import { DateTime, Effect } from "effect";
import type { EmailVerificationCode } from "~/core/email-authentication/model";
import type { UserId } from "~/core/identity/reference";
import { withSubjectLock } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { type ResolvedWebSession, lockFreshWebSessionInScope } from "~/shell/web-session/repo";
import { emailDeliveryBudgetKey } from "./admission";
import type { RequestEmailReplacementPayload } from "./operations";
import { acquireEmailVerificationAdmissionInScope } from "./repo";
import { completeReplacementInScope, requestReplacementInScope } from "./replacement-repo";

/** Requests one bounded replacement delivery for an already-authorized User. */
export const requestEmailReplacement = Effect.fn("EmailAuthentication.requestEmailReplacement")(
  function* (input: { userId: UserId; payload: typeof RequestEmailReplacementPayload.Type }) {
    const requestedAt = yield* DateTime.now;
    yield* withSubjectLock(
      input.userId,
      requestReplacementInScope({
        userId: input.userId,
        candidateEmail: input.payload.candidateEmail,
        requestedAt,
        callerBudgetKey: yield* emailDeliveryBudgetKey(`user:${input.userId}`).pipe(Effect.orDie),
        recipientBudgetKey: yield* emailDeliveryBudgetKey(
          `recipient:${input.payload.candidateEmail}`
        ).pipe(Effect.orDie),
      })
    );
    return { data: { status: "pending" as const }, next: [] };
  }
);

/** Direct completion authority: freshness is checked before any replacement persistence lookup. */
export const completeEmailReplacement = Effect.fn("EmailAuthentication.completeEmailReplacement")(
  function* (input: {
    session: ResolvedWebSession;
    attemptedAt: DateTime.Utc;
    combinedCode: EmailVerificationCode;
  }) {
    if (
      DateTime.toEpochMillis(input.attemptedAt) >= DateTime.toEpochMillis(input.session.freshUntil)
    ) {
      return "fresh-pairing-required" as const;
    }
    return yield* withUserTransaction(
      input.session.subjectUserId,
      withSubjectLock(
        input.session.subjectUserId,
        Effect.gen(function* () {
          const sessionRemainsFresh = yield* lockFreshWebSessionInScope({
            webSessionId: input.session.webSessionId,
            subjectUserId: input.session.subjectUserId,
            attemptedAt: input.attemptedAt,
          });
          if (!sessionRemainsFresh) return "fresh-pairing-required" as const;
          if (!(yield* acquireEmailVerificationAdmissionInScope())) return "rejected" as const;
          return yield* completeReplacementInScope({
            userId: input.session.subjectUserId,
            authorizingWebSessionId: input.session.webSessionId,
            attemptedAt: input.attemptedAt,
            combinedCode: input.combinedCode,
          });
        })
      )
    );
  }
);
