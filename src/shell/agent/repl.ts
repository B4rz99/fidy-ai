import { Crypto, DateTime, Effect, Option, Schema, Terminal } from "effect";
import type { E164PhoneNumber } from "~/core/identity/reference";
import {
  claimConsentDisclosureDelivery,
  recordConsentDisclosureDelivery,
  releaseConsentDisclosureDelivery,
} from "~/shell/consent/repo";
import { type AgentConversationOutcome, handleAgentConversationTurn } from "./conversation";
import { InboundMessage } from "./agent-service";

const invalidMessage = "Escribe un mensaje de texto no vacío.\n";
const unavailableMessage = "Fidy no está disponible en este momento. Intenta de nuevo.\n";

const renderTerminalText = (text: string): string =>
  Array.from(text, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined &&
      ((codePoint < 32 && codePoint !== 10) || (codePoint >= 127 && codePoint <= 159))
      ? "�"
      : character;
  }).join("");

const displayConversationOutcome = Effect.fn("displayConversationOutcome")(function* (
  outcome: AgentConversationOutcome
) {
  const terminal = yield* Terminal.Terminal;
  if (outcome._tag === "AwaitingDisclosureDelivery") {
    return yield* terminal.display(unavailableMessage);
  }
  if (outcome._tag === "AgentReplied") {
    return yield* terminal.display(`${renderTerminalText(outcome.reply.text)}\n`);
  }

  if (outcome._tag !== "SendDisclosure") {
    return yield* terminal.display(`${renderTerminalText(outcome.text)}\n`);
  }
  const claimedAt = yield* DateTime.now;
  const claim = yield* claimConsentDisclosureDelivery(outcome.exchangeId, claimedAt);
  if (Option.isNone(claim)) return yield* terminal.display(unavailableMessage);
  yield* Effect.gen(function* () {
    yield* terminal.display(`${renderTerminalText(outcome.text)}\n`);
    const crypto = yield* Crypto.Crypto;
    const recorded = yield* recordConsentDisclosureDelivery({
      exchangeId: outcome.exchangeId,
      claimId: claim.value.claimId,
      message: {
        channel: "terminal",
        provider: "local-repl",
        providerMessageId: `repl:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
      },
      deliveredAt: yield* DateTime.now,
    });
    if (Option.isNone(recorded)) return yield* terminal.display(unavailableMessage);
  }).pipe(
    Effect.onError(() =>
      releaseConsentDisclosureDelivery({
        exchangeId: outcome.exchangeId,
        claimId: claim.value.claimId,
      })
    )
  );
});

/**
 * Runs channel-neutral gated turns for one normalized WhatsApp number until
 * Terminal reports quit. Consent replies terminate their turns; only later
 * authorized text reaches AgentService. Terminal failures remain typed.
 */
export const runAgentRepl = Effect.fn("runAgentRepl")(function* (phoneNumber: E164PhoneNumber) {
  const terminal = yield* Terminal.Terminal;
  const crypto = yield* Crypto.Crypto;
  const turn = Effect.gen(function* () {
    yield* terminal.display("Fidy> ");
    const text = yield* terminal.readLine;
    const message = yield* Schema.decodeUnknownEffect(InboundMessage)({ text }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("SchemaError", () =>
        terminal.display(invalidMessage).pipe(Effect.as(Option.none<InboundMessage>()))
      )
    );
    if (Option.isNone(message)) return;

    const outcome = yield* handleAgentConversationTurn({
      phoneNumber,
      content: { _tag: "Text", text: message.value.text },
      message: {
        channel: "terminal",
        provider: "local-repl",
        providerMessageId: `repl:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
      },
      receivedAt: yield* DateTime.now,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        ModelUnavailable: () =>
          terminal
            .display(unavailableMessage)
            .pipe(Effect.as(Option.none<AgentConversationOutcome>())),
        OnboardingConsentRequired: () =>
          terminal
            .display(unavailableMessage)
            .pipe(Effect.as(Option.none<AgentConversationOutcome>())),
        UnknownUser: () =>
          terminal
            .display(unavailableMessage)
            .pipe(Effect.as(Option.none<AgentConversationOutcome>())),
      })
    );
    if (Option.isSome(outcome)) {
      yield* displayConversationOutcome(outcome.value);
    }
  });

  yield* turn.pipe(
    Effect.forever,
    Effect.catchIf(Terminal.isQuitError, () => Effect.void)
  );
});
