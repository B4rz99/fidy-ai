import { Crypto, DateTime, Effect, Option, Result, Schema } from "effect";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import {
  type ConsentRecord,
  type DisclosureSnapshot,
  type PendingConsentExchange,
  PendingConsentExchangeId,
} from "~/core/consent/model";
import {
  decideConsentReply,
  hasPendingConsentExpired,
  makePendingConsentDraft,
} from "~/core/consent/rules";
import { type UserId, whatsAppCallerReference } from "~/core/identity/reference";
import {
  EmailAddress,
  EmailDeliveryIntentId,
  EmailEnrollmentId,
  EmailVerificationPublicCode,
  maximumEmailDeliveryGenerations,
} from "~/core/email-authentication/model";
import {
  emailWorkflowExpiry,
  formatEmailCode,
  resendAvailability,
  selectEmailCodeSymbols,
} from "~/core/email-authentication/rules";
import type { WhatsAppCaller } from "~/shell/channels/whatsapp/model";
import { findWhatsAppCaller, resolveWhatsAppCaller } from "~/shell/identity/repo";
import type { OnboardingTurn, OnboardingTurnOutcome } from "./types";
import { admitEmailDeliveryInScope } from "~/shell/email-authentication/admission";
import { publishOnboardingEmailDelivery } from "~/shell/onboarding/delivery-workflow";
import {
  type EmailEnrollmentRow,
  findAndLockEmailEnrollmentByCaller,
  insertEmailEnrollment,
  removeEmailEnrollment,
  submitEnrollmentEmail,
} from "~/shell/email-authentication/repo";
import { currentDisclosure } from "~/shell/consent/current-disclosure";
import {
  findConsentRecordByDecisionMessage,
  findPendingConsentExchange,
  hasCurrentOnboardingConsent,
  insertPendingConsentExchange,
  markPendingConsentAcceptedInScope,
  removePendingConsentExchange,
  withConsentLock,
  withSubjectLock,
} from "~/shell/consent/repo";

const sendDisclosure = (exchangeId: PendingConsentExchangeId): OnboardingTurnOutcome => ({
  _tag: "SendDisclosure",
  exchangeId,
});

const beginPendingExchange = Effect.fn(function* (
  input: Pick<OnboardingTurn, "caller" | "message" | "receivedAt">
) {
  const crypto = yield* Crypto.Crypto;
  const disclosure = yield* currentDisclosure;
  const pending = {
    ...(yield* makePendingConsentDraft({
      id: PendingConsentExchangeId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
      disclosure,
      initiatingMessage: input.message,
      createdAt: input.receivedAt,
    })),
    caller: whatsAppCallerReference(input.caller),
  } satisfies Extract<PendingConsentExchange, { readonly _tag: "AwaitingDisclosureDelivery" }>;
  yield* insertPendingConsentExchange(pending);
  return sendDisclosure(pending.id);
});

const isOnboardingGrant = (record: ConsentRecord): boolean =>
  record.event._tag === "Granted" && record.event.grant._tag === "Onboarding";
const disclosureFingerprint = (disclosure: DisclosureSnapshot): string =>
  JSON.stringify([
    disclosure.revision,
    disclosure.contentSha256,
    disclosure.policy.revision,
    disclosure.policy.contentSha256,
  ]);

const isCurrentDisclosure = (candidate: DisclosureSnapshot, current: DisclosureSnapshot): boolean =>
  disclosureFingerprint(candidate) === disclosureFingerprint(current);

const awaitingEmailOutcome: OnboardingTurnOutcome = { _tag: "AwaitingEmail" };
const emailSubmittedOutcome: OnboardingTurnOutcome = { _tag: "EmailSubmitted", status: "sent" };
const decisionBelongsToAnotherIdentity: OnboardingTurnOutcome = {
  _tag: "ClarifyDecision",
  reason: "another-identity",
};
const earlierDecisionNoLongerCurrent: OnboardingTurnOutcome = {
  _tag: "ClarifyDecision",
  reason: "stale-decision",
};
const decisionRepeatsInitiatingMessage: OnboardingTurnOutcome = {
  _tag: "ClarifyDecision",
  reason: "replayed-initiating-message",
};
const decisionPrecedesDisclosure: OnboardingTurnOutcome = {
  _tag: "ClarifyDecision",
  reason: "decision-before-disclosure",
};
const undecidedReply: OnboardingTurnOutcome = {
  _tag: "ClarifyDecision",
  reason: "unrecognized-decision",
};
const declinedOutcome: OnboardingTurnOutcome = { _tag: "Declined", reason: "declined" };

const enrollmentPublicSymbolCount = 8;
const groupedCodeSymbolCount = 4;

const acceptPending = Effect.fn(function* (
  input: OnboardingTurn,
  pending: Extract<PendingConsentExchange, { readonly _tag: "AwaitingDecision" }>
) {
  const crypto = yield* Crypto.Crypto;
  const publicSymbols = selectEmailCodeSymbols({
    bytes: yield* crypto.randomBytes(enrollmentPublicSymbolCount).pipe(Effect.orDie),
    maximum: enrollmentPublicSymbolCount,
  });
  yield* markPendingConsentAcceptedInScope({
    pendingExchangeId: pending.id,
    decisionMessage: input.message,
    acceptedAt: input.receivedAt,
  });
  yield* insertEmailEnrollment({
    id: EmailEnrollmentId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
    publicCode: EmailVerificationPublicCode.make(
      formatEmailCode({
        symbols: publicSymbols,
        groupSize: groupedCodeSymbolCount,
      })
    ),
    caller: input.caller,
    pendingConsentExchangeId: pending.id,
    expiresAt: emailWorkflowExpiry(input.receivedAt),
  });
  return awaitingEmailOutcome;
});

const settledReplayOutcome = Effect.fn(function* ({
  caller,
  replay,
  disclosure,
}: Readonly<{
  caller: Option.Option<UserId>;
  replay: ConsentRecord;
  disclosure: DisclosureSnapshot;
}>) {
  const belongsToCaller = Option.isSome(caller) && caller.value === replay.subjectUserId;
  if (!belongsToCaller || !isOnboardingGrant(replay)) {
    return Option.some<OnboardingTurnOutcome>(decisionBelongsToAnotherIdentity);
  }
  if (!isCurrentDisclosure(replay.disclosure, disclosure)) {
    return Option.none<OnboardingTurnOutcome>();
  }
  return yield* withSubjectLock(
    replay.subjectUserId,
    Effect.gen(function* () {
      if (yield* hasCurrentOnboardingConsent(replay.subjectUserId)) {
        return Option.some<OnboardingTurnOutcome>({
          _tag: "Accepted",
          userId: replay.subjectUserId,
        });
      }
      return Option.none<OnboardingTurnOutcome>();
    })
  );
});

const usablePendingExchange = Effect.fn(function* ({
  caller,
  disclosure,
  now,
}: Readonly<{
  caller: WhatsAppCaller;
  disclosure: DisclosureSnapshot;
  now: DateTime.Utc;
}>) {
  const found = yield* findPendingConsentExchange(caller);
  if (Option.isNone(found)) return Option.none();

  const pending = found.value;
  if (!isCurrentDisclosure(pending.disclosure, disclosure)) {
    yield* removePendingConsentExchange(pending.id);
    return Option.none();
  }
  if (yield* hasPendingConsentExpired({ pending, now })) {
    yield* removePendingConsentExchange(pending.id);
    return Option.none();
  }
  return Option.some(pending);
});

const decodeEmailAddress = Schema.decodeUnknownResult(EmailAddress);

const removeBoundedEnrollmentEvidence = Effect.fn(function* (enrollment: EmailEnrollmentRow) {
  yield* removeEmailEnrollment(enrollment.id);
  yield* removePendingConsentExchange(enrollment.consent.pendingConsentExchangeId);
});

const terminalEnrollmentOutcome = Effect.fn(function* (
  input: OnboardingTurn,
  enrollment: EmailEnrollmentRow
) {
  if (DateTime.isGreaterThanOrEqualTo(input.receivedAt, enrollment.expiresAt)) {
    yield* removeBoundedEnrollmentEvidence(enrollment);
    return Option.some<OnboardingTurnOutcome>({ _tag: "Declined", reason: "expired" });
  }
  const command =
    input.content._tag === "Text" ? input.content.text.trim().toLocaleLowerCase("es") : "";
  if (command !== "cancelar" && command !== "no acepto") return Option.none();
  yield* removeBoundedEnrollmentEvidence(enrollment);
  return Option.some(declinedOutcome);
});

type EmailInstruction =
  | Readonly<{ _tag: "Await" }>
  | Readonly<{ _tag: "AlreadySubmitted" }>
  | Readonly<{ _tag: "Cooldown" }>
  | Readonly<{ _tag: "QuotaReached" }>
  | Readonly<{ _tag: "Submit"; email: EmailAddress }>;

const inboundText = (input: OnboardingTurn): string =>
  input.content._tag === "Text" ? input.content.text.trim() : "";

const priorEmailInstruction = (enrollment: EmailEnrollmentRow): EmailInstruction =>
  enrollment._tag === "AwaitingEmail" ? { _tag: "Await" } : { _tag: "AlreadySubmitted" };

const deliveryCooldownActive = (input: OnboardingTurn, enrollment: EmailEnrollmentRow): boolean =>
  enrollment._tag !== "AwaitingEmail" &&
  DateTime.isLessThan(input.receivedAt, enrollment.resendAvailableAt);

const availableResendInstruction = (
  input: OnboardingTurn,
  enrollment: Exclude<EmailEnrollmentRow, { readonly _tag: "AwaitingEmail" }>
): EmailInstruction =>
  deliveryCooldownActive(input, enrollment)
    ? { _tag: "Cooldown" }
    : { _tag: "Submit", email: enrollment.email };

const submittedResendInstruction = (
  input: OnboardingTurn,
  enrollment: Exclude<EmailEnrollmentRow, { readonly _tag: "AwaitingEmail" }>
): EmailInstruction =>
  enrollment.deliveryGeneration >= maximumEmailDeliveryGenerations
    ? { _tag: "QuotaReached" }
    : availableResendInstruction(input, enrollment);

const resendInstruction = (
  input: OnboardingTurn,
  enrollment: EmailEnrollmentRow
): EmailInstruction =>
  enrollment._tag === "AwaitingEmail"
    ? priorEmailInstruction(enrollment)
    : submittedResendInstruction(input, enrollment);

const nonEmailInstruction = (
  input: OnboardingTurn,
  enrollment: EmailEnrollmentRow,
  raw: string
): EmailInstruction =>
  raw.toLocaleLowerCase("es") === "reenviar"
    ? resendInstruction(input, enrollment)
    : priorEmailInstruction(enrollment);

const submittedAddressInstruction = (
  enrollment: Exclude<EmailEnrollmentRow, { readonly _tag: "AwaitingEmail" }>,
  email: EmailAddress
): EmailInstruction =>
  enrollment.deliveryGeneration >= maximumEmailDeliveryGenerations
    ? { _tag: "QuotaReached" }
    : { _tag: "Submit", email };

const decodedAddressInstruction = (
  enrollment: EmailEnrollmentRow,
  email: EmailAddress
): EmailInstruction =>
  enrollment._tag === "AwaitingEmail"
    ? { _tag: "Submit", email }
    : submittedAddressInstruction(enrollment, email);

const chooseEmailInstruction = (
  input: OnboardingTurn,
  enrollment: EmailEnrollmentRow
): EmailInstruction => {
  const raw = inboundText(input);
  return Result.match(decodeEmailAddress(raw), {
    onFailure: () => nonEmailInstruction(input, enrollment, raw),
    onSuccess: (email) => decodedAddressInstruction(enrollment, email),
  });
};

const handleEmailEnrollment = Effect.fn(function* (
  input: OnboardingTurn,
  enrollment: EmailEnrollmentRow
) {
  const terminal = yield* terminalEnrollmentOutcome(input, enrollment);
  if (Option.isSome(terminal)) return terminal.value;

  const instruction = chooseEmailInstruction(input, enrollment);
  if (instruction._tag === "Await") return awaitingEmailOutcome;
  if (instruction._tag === "AlreadySubmitted") return emailSubmittedOutcome;
  if (instruction._tag === "Cooldown") {
    return { _tag: "EmailSubmitted" as const, status: "cooldown" as const };
  }
  if (instruction._tag === "QuotaReached") {
    return { _tag: "EmailSubmitted" as const, status: "quota-reached" as const };
  }
  const deliveryAdmitted = yield* admitEmailDeliveryInScope({
    requester: {
      _tag: "WhatsAppCaller",
      businessPortfolioId: input.caller.businessPortfolioId,
      businessScopedUserId: input.caller.businessScopedUserId,
    },
    recipient: instruction.email,
    attemptedAt: input.receivedAt,
  });
  if (!deliveryAdmitted) {
    return { _tag: "EmailSubmitted" as const, status: "quota-reached" as const };
  }
  const crypto = yield* Crypto.Crypto;
  const intentId = EmailDeliveryIntentId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  const admitted = yield* submitEnrollmentEmail({
    enrollmentId: enrollment.id,
    email: instruction.email,
    intentId,
    idempotencyKey: intentId,
    submittedAt: input.receivedAt,
    resendAvailableAt: resendAvailability(input.receivedAt),
  });
  if (Option.isNone(admitted)) {
    return yield* Effect.die("Admitted email delivery did not advance its locked enrollment");
  }
  yield* publishOnboardingEmailDelivery(intentId);
  return emailSubmittedOutcome;
});

const isSameProviderMessage = Schema.toEquivalence(ProviderMessageEvidence);

const decideAwaitedConsent = Effect.fn(function* ({
  input,
  pending,
  replay,
}: Readonly<{
  input: OnboardingTurn;
  pending: Extract<PendingConsentExchange, { readonly _tag: "AwaitingDecision" }>;
  replay: Option.Option<ConsentRecord>;
}>) {
  if (Option.isSome(replay)) return earlierDecisionNoLongerCurrent;
  if (isSameProviderMessage(input.message, pending.initiatingMessage)) {
    return decisionRepeatsInitiatingMessage;
  }
  if (DateTime.Order(input.receivedAt, pending.disclosedAt) < 0) return decisionPrecedesDisclosure;

  const decision = yield* decideConsentReply(input.content);
  if (decision._tag === "Clarify") return undecidedReply;
  if (decision._tag === "Declined") {
    yield* removePendingConsentExchange(pending.id);
    return declinedOutcome;
  }

  return yield* acceptPending(input, pending);
});

/**
 * Evaluates one inbound turn serialized by its Business Portfolio and BSUID reference. The
 * function stores no initiating content, deletes temporary state on all terminal paths, and never
 * returns `Proceed` for the acceptance message itself.
 */
export const handleOnboardingTurnTransition = Effect.fn(function* (input: OnboardingTurn) {
  const outcome = yield* withConsentLock(
    input.caller,
    Effect.gen(function* () {
      const caller = yield* findWhatsAppCaller(input.caller);
      const disclosure = yield* currentDisclosure;
      const replay = yield* findConsentRecordByDecisionMessage(input.message);
      if (Option.isSome(replay)) {
        const settled = yield* settledReplayOutcome({
          caller,
          replay: replay.value,
          disclosure,
        });
        if (Option.isSome(settled)) return settled.value;
      }

      if (Option.isSome(caller) && (yield* hasCurrentOnboardingConsent(caller.value))) {
        return { _tag: "Proceed", userId: caller.value } as const;
      }

      const enrollment = yield* findAndLockEmailEnrollmentByCaller(input.caller);
      if (Option.isSome(enrollment)) {
        return yield* handleEmailEnrollment(input, enrollment.value);
      }

      const usable = yield* usablePendingExchange({
        caller: input.caller,
        disclosure,
        now: input.receivedAt,
      });
      if (Option.isNone(usable)) return yield* beginPendingExchange(input);

      const pending = usable.value;
      if (pending._tag === "AwaitingDisclosureDelivery") {
        return {
          _tag: "AwaitingDisclosureDelivery",
          exchangeId: pending.id,
        } as const;
      }

      return yield* decideAwaitedConsent({ input, pending, replay });
    })
  ).pipe(Effect.catchTag("SqlError", Effect.die));

  // Mutable provider evidence belongs to Identity and refreshes after Consent commits.
  yield* resolveWhatsAppCaller(input.caller, input.receivedAt);
  return outcome;
});
