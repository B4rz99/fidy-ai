import { Crypto, DateTime, Effect, Option, Schema } from "effect";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import {
  type ConsentInboundContent,
  ConsentRecord,
  ConsentRecordId,
  type DisclosureSnapshot,
  type PendingConsentExchange,
  PendingConsentExchangeId,
} from "~/core/consent/model";
import {
  decideConsentReply,
  hasPendingConsentExpired,
  makePendingConsentDraft,
} from "~/core/consent/rules";
import { UserId, whatsAppCallerReference } from "~/core/identity/reference";
import type { WhatsAppCaller } from "~/shell/channels/whatsapp/model";
import { makeColombianUser } from "~/core/identity/rules";
import {
  findWhatsAppCaller,
  insertUser,
  insertWhatsAppIdentity,
  resolveWhatsAppCaller,
} from "~/shell/identity/repo";
import { CURRENT_DISCLOSURE_TEXT, currentDisclosure } from "./current-disclosure";
import {
  appendConsentRecord,
  findConsentRecordByDecisionMessage,
  findPendingConsentExchange,
  hasCurrentOnboardingConsent,
  insertPendingConsentExchange,
  removePendingConsentExchange,
  withConsentLock,
  withSubjectLock,
} from "./repo";

/** One provider-authenticated inbound turn presented to the consent boundary. */
export type ConsentGateInput = {
  readonly caller: WhatsAppCaller;
  readonly content: ConsentInboundContent;
  readonly message: ProviderMessageEvidence;
  readonly receivedAt: DateTime.Utc;
};

/**
 * Exhaustive instruction to the channel adapter. Only `Proceed` may enter the
 * model/canonical pipeline; acceptance is deliberately a terminal turn.
 */
export type ConsentGateOutcome =
  | Readonly<{
      readonly _tag: "SendDisclosure";
      readonly exchangeId: PendingConsentExchangeId;
      readonly text: string;
      readonly choices: readonly ["accept", "decline"];
    }>
  | Readonly<{
      readonly _tag: "AwaitingDisclosureDelivery";
      readonly exchangeId: PendingConsentExchangeId;
    }>
  | Readonly<{ readonly _tag: "ClarifyDecision"; readonly text: string }>
  | Readonly<{ readonly _tag: "Declined"; readonly text: string }>
  | Readonly<{ readonly _tag: "Accepted"; readonly userId: UserId; readonly text: string }>
  | Readonly<{ readonly _tag: "Proceed"; readonly userId: UserId }>;

const sendDisclosure = (exchangeId: PendingConsentExchangeId): ConsentGateOutcome => ({
  _tag: "SendDisclosure",
  exchangeId,
  text: CURRENT_DISCLOSURE_TEXT,
  choices: ["accept", "decline"],
});

const beginPendingExchange = Effect.fn("beginPendingConsentExchange")(function* (
  input: Pick<ConsentGateInput, "caller" | "message" | "receivedAt">
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
const isCurrentDisclosure = (candidate: DisclosureSnapshot, current: DisclosureSnapshot): boolean =>
  candidate.revision === current.revision &&
  candidate.contentSha256 === current.contentSha256 &&
  candidate.policy.revision === current.policy.revision &&
  candidate.policy.contentSha256 === current.policy.contentSha256;

const acceptedOutcome = (userId: UserId): ConsentGateOutcome => ({
  _tag: "Accepted",
  userId,
  text: "Autorización registrada. Tu cuenta está lista; envía de nuevo lo que quieras registrar.",
});

const decisionBelongsToAnotherIdentity: ConsentGateOutcome = {
  _tag: "ClarifyDecision",
  text: "Esa decisión ya fue registrada para otra identidad.",
};

const earlierDecisionNoLongerCurrent: ConsentGateOutcome = {
  _tag: "ClarifyDecision",
  text: "La autorización anterior ya no está vigente. Responde Acepto en un mensaje nuevo.",
};

const decisionRepeatsInitiatingMessage: ConsentGateOutcome = {
  _tag: "ClarifyDecision",
  text: "Para autorizar, envía una decisión nueva después de recibir la información.",
};

const decisionPrecedesDisclosure: ConsentGateOutcome = {
  _tag: "ClarifyDecision",
  text: "Para autorizar, responde después de recibir la información de tratamiento.",
};

const undecidedReply: ConsentGateOutcome = {
  _tag: "ClarifyDecision",
  text: "Para autorizar responde “Acepto”; para continuar sin crear cuenta responde “No acepto”.",
};

const declinedOutcome: ConsentGateOutcome = {
  _tag: "Declined",
  text: "Entendido. No creé una cuenta ni conservé tu información financiera.",
};

const acceptPending = Effect.fn("acceptPendingConsent")(function* (
  input: ConsentGateInput,
  pending: Extract<PendingConsentExchange, { readonly _tag: "AwaitingDecision" }>
) {
  const crypto = yield* Crypto.Crypto;
  const resolved = yield* findWhatsAppCaller(input.caller);
  const userId = Option.isSome(resolved)
    ? resolved.value
    : UserId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));

  if (Option.isNone(resolved)) {
    const user = yield* makeColombianUser(userId, { createdAt: input.receivedAt });
    yield* insertUser(userId, user);
    yield* insertWhatsAppIdentity(userId, {
      ...input.caller,
      verifiedAt: input.receivedAt,
    });
  }

  const record = ConsentRecord.make({
    id: ConsentRecordId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
    subjectUserId: userId,
    event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
    disclosure: pending.disclosure,
    occurredAt: input.receivedAt,
    disclosureMessage: pending.disclosureMessage,
    decisionMessage: input.message,
  });
  yield* appendConsentRecord(record);
  yield* removePendingConsentExchange(pending.id);

  return acceptedOutcome(userId);
});

const settledReplayOutcome = Effect.fn("settledConsentReplayOutcome")(function* ({
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
    return Option.some(decisionBelongsToAnotherIdentity);
  }
  if (!isCurrentDisclosure(replay.disclosure, disclosure)) return Option.none();
  return yield* withSubjectLock(
    replay.subjectUserId,
    Effect.gen(function* () {
      if (yield* hasCurrentOnboardingConsent(replay.subjectUserId)) {
        return Option.some(acceptedOutcome(replay.subjectUserId));
      }
      return Option.none();
    })
  );
});

const usablePendingExchange = Effect.fn("usablePendingConsentExchange")(function* ({
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

const isSameProviderMessage = Schema.toEquivalence(ProviderMessageEvidence);

const decideAwaitedConsent = Effect.fn("decideAwaitedConsent")(function* ({
  input,
  pending,
  replay,
}: Readonly<{
  input: ConsentGateInput;
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
export const evaluateConsentGate = Effect.fn("evaluateConsentGate")(function* (
  input: ConsentGateInput
) {
  const outcome = yield* withConsentLock(
    input.caller,
    Effect.gen(function* () {
      const caller = yield* findWhatsAppCaller(input.caller);
      const disclosure = yield* currentDisclosure;
      const replay = yield* findConsentRecordByDecisionMessage(input.message);
      if (Option.isSome(replay)) {
        const settled = yield* settledReplayOutcome({ caller, replay: replay.value, disclosure });
        if (Option.isSome(settled)) return settled.value;
      }

      if (Option.isSome(caller) && (yield* hasCurrentOnboardingConsent(caller.value))) {
        return { _tag: "Proceed", userId: caller.value } as const;
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
