import { Crypto, DateTime, Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import {
  ConsentRecord,
  ConsentRecordId,
  type ConsentInboundContent,
  type DisclosureSnapshot,
  type PendingConsentExchange,
  PendingConsentExchangeId,
} from "~/core/consent/model";
import {
  decideConsentReply,
  hasPendingConsentExpired,
  makePendingConsentExchange,
} from "~/core/consent/rules";
import { type E164PhoneNumber, UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { insertUser, insertWhatsAppIdentity, resolveWhatsAppCaller } from "~/shell/identity/repo";
import { currentDisclosure, CURRENT_DISCLOSURE_TEXT } from "./current-disclosure";
import {
  appendConsentRecord,
  findConsentRecordByDecisionMessage,
  findPendingConsentExchange,
  hasCurrentOnboardingConsent,
  insertPendingConsentExchange,
  lockConsentGate,
  lockConsentSubject,
  removePendingConsentExchange,
} from "./repo";

/** One provider-authenticated inbound turn presented to the consent boundary. */
export type ConsentGateInput = {
  readonly phoneNumber: E164PhoneNumber;
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
  input: Pick<ConsentGateInput, "phoneNumber" | "message" | "receivedAt">
) {
  const crypto = yield* Crypto.Crypto;
  const disclosure = yield* currentDisclosure;
  const pending = yield* makePendingConsentExchange({
    id: PendingConsentExchangeId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
    phoneNumber: input.phoneNumber,
    disclosure,
    initiatingMessage: input.message,
    createdAt: input.receivedAt,
  });
  yield* insertPendingConsentExchange(pending);
  return sendDisclosure(pending.id);
});

const isOnboardingGrant = (record: ConsentRecord): boolean =>
  record.event._tag === "Granted" && record.event.grant._tag === "Onboarding";
const isCurrentDisclosure = (candidate: DisclosureSnapshot, current: DisclosureSnapshot) =>
  candidate.revision === current.revision &&
  candidate.contentSha256 === current.contentSha256 &&
  candidate.policy.revision === current.policy.revision &&
  candidate.policy.contentSha256 === current.policy.contentSha256;

const acceptedOutcome = (userId: UserId): ConsentGateOutcome => ({
  _tag: "Accepted",
  userId,
  text: "Autorización registrada. Tu cuenta está lista; envía de nuevo lo que quieras registrar.",
});

const acceptPending = Effect.fn("acceptPendingConsent")(function* (
  input: ConsentGateInput,
  pending: Extract<PendingConsentExchange, { readonly _tag: "AwaitingDecision" }>
) {
  const crypto = yield* Crypto.Crypto;
  const caller = yield* resolveWhatsAppCaller(input.phoneNumber);
  const userId = Option.isSome(caller)
    ? caller.value
    : UserId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));

  if (Option.isNone(caller)) {
    const user = yield* makeColombianUser(userId, { createdAt: input.receivedAt });
    yield* insertUser(userId, user);
    yield* insertWhatsAppIdentity(userId, {
      phoneNumber: input.phoneNumber,
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

/**
 * Evaluates one inbound turn under a phone-scoped transaction. The function
 * stores no initiating content, deletes temporary state on all terminal paths,
 * and never returns `Proceed` for the acceptance message itself.
 */
export const evaluateConsentGate = Effect.fn("evaluateConsentGate")(function* (
  input: ConsentGateInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* lockConsentGate(input.phoneNumber);

        const caller = yield* resolveWhatsAppCaller(input.phoneNumber);
        const disclosure = yield* currentDisclosure;
        const replay = yield* findConsentRecordByDecisionMessage(input.message);
        if (Option.isSome(replay)) {
          const belongsToCaller =
            Option.isSome(caller) && caller.value === replay.value.subjectUserId;
          if (!belongsToCaller || !isOnboardingGrant(replay.value)) {
            return {
              _tag: "ClarifyDecision",
              text: "Esa decisión ya fue registrada para otra identidad.",
            } as const;
          }
          if (isCurrentDisclosure(replay.value.disclosure, disclosure)) {
            yield* lockConsentSubject(replay.value.subjectUserId);
            if (yield* hasCurrentOnboardingConsent(replay.value.subjectUserId)) {
              return acceptedOutcome(replay.value.subjectUserId);
            }
          }
        }

        if (Option.isSome(caller) && (yield* hasCurrentOnboardingConsent(caller.value))) {
          return { _tag: "Proceed", userId: caller.value } as const;
        }

        const foundPending = yield* findPendingConsentExchange(input.phoneNumber);
        if (Option.isNone(foundPending)) {
          return yield* beginPendingExchange(input);
        }

        const pending = foundPending.value;
        if (!isCurrentDisclosure(pending.disclosure, disclosure)) {
          yield* removePendingConsentExchange(pending.id);
          return yield* beginPendingExchange(input);
        }
        if (yield* hasPendingConsentExpired({ pending, now: input.receivedAt })) {
          yield* removePendingConsentExchange(pending.id);
          return yield* beginPendingExchange(input);
        }
        if (pending._tag === "AwaitingDisclosureDelivery") {
          return {
            _tag: "AwaitingDisclosureDelivery",
            exchangeId: pending.id,
          } as const;
        }

        if (Option.isSome(replay)) {
          return {
            _tag: "ClarifyDecision",
            text: "La autorización anterior ya no está vigente. Responde Acepto en un mensaje nuevo.",
          } as const;
        }

        if (
          input.message.channel === pending.initiatingMessage.channel &&
          input.message.provider === pending.initiatingMessage.provider &&
          input.message.providerMessageId === pending.initiatingMessage.providerMessageId
        ) {
          return {
            _tag: "ClarifyDecision",
            text: "Para autorizar, envía una decisión nueva después de recibir la información.",
          } as const;
        }

        if (DateTime.Order(input.receivedAt, pending.disclosedAt) < 0) {
          return {
            _tag: "ClarifyDecision",
            text: "Para autorizar, responde después de recibir la información de tratamiento.",
          } as const;
        }

        const decision = yield* decideConsentReply(input.content);
        if (decision._tag === "Clarify") {
          return {
            _tag: "ClarifyDecision",
            text: "Para autorizar responde “Acepto”; para continuar sin crear cuenta responde “No acepto”.",
          } as const;
        }
        if (decision._tag === "Declined") {
          yield* removePendingConsentExchange(pending.id);
          return {
            _tag: "Declined",
            text: "Entendido. No creé una cuenta ni conservé tu información financiera.",
          } as const;
        }

        return yield* acceptPending(input, pending);
      })
    )
    .pipe(Effect.catchTag("SqlError", Effect.die));
});
