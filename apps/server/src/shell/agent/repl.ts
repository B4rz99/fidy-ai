import { Config, Crypto, DateTime, Effect, Option, Schema, Terminal } from "effect";
import {
  type E164PhoneNumber,
  WhatsAppBusinessPortfolioId,
  type WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import { CURRENT_DISCLOSURE_TEXT } from "~/shell/consent/current-disclosure";
import { recordLocalConsentDisclosureDelivery } from "~/shell/consent/repo";
import { type AgentConversationOutcome, handleAgentConversationTurn } from "./conversation";
import { InboundMessage } from "./agent-service";

const firstPrintableCodePoint = 32;
const lineFeedCodePoint = 10;
const deleteCodePoint = 127;
const lastC1ControlCodePoint = 159;

const invalidMessage = "Escribe un mensaje de texto no vacío.\n";
const unavailableMessage = "Fidy no está disponible en este momento. Intenta de nuevo.\n";

type ReplCaller = Readonly<{
  phoneNumber: E164PhoneNumber;
  businessScopedUserId: WhatsAppBusinessScopedUserId;
}>;

const renderTerminalText = (text: string): string =>
  Array.from(text, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined &&
      ((codePoint < firstPrintableCodePoint && codePoint !== lineFeedCodePoint) ||
        (codePoint >= deleteCodePoint && codePoint <= lastC1ControlCodePoint))
      ? "�"
      : character;
  }).join("");

const terminalOutcomeText = (
  outcome: Exclude<AgentConversationOutcome, { readonly _tag: "AgentReplied" }>
): string => {
  if (outcome._tag === "SendDisclosure") return CURRENT_DISCLOSURE_TEXT;
  if (outcome._tag === "AwaitingEmail") return "Autorización registrada. Escribe tu correo.";
  if (outcome._tag === "EmailSubmitted") return "Revisa tu correo para verificarlo.";
  if (outcome._tag === "Accepted") return "Tu cuenta ya está lista.";
  if (outcome._tag === "Declined") return "No creé una cuenta.";
  return "Aclara tu respuesta para continuar.";
};

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
    return yield* terminal.display(`${renderTerminalText(terminalOutcomeText(outcome))}\n`);
  }
  yield* terminal.display(`${renderTerminalText(terminalOutcomeText(outcome))}\n`);
  const crypto = yield* Crypto.Crypto;
  const recorded = yield* recordLocalConsentDisclosureDelivery({
    exchangeId: outcome.exchangeId,
    message: {
      channel: "terminal",
      provider: "local-repl",
      providerMessageId: `repl:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
    },
    deliveredAt: yield* DateTime.now,
  });
  if (Option.isNone(recorded)) return yield* terminal.display(unavailableMessage);
});

/**
 * Runs channel-neutral gated turns for one explicitly configured development association until
 * Terminal reports quit. The Business Portfolio and BSUID must match an existing seeded
 * WhatsAppIdentity; the REPL never derives provider identity from phone evidence. Consent replies
 * terminate their turns, and only later authorized text reaches AgentService.
 */
export const runAgentRepl = Effect.fn("runAgentRepl")(function* (caller: ReplCaller) {
  const terminal = yield* Terminal.Terminal;
  const crypto = yield* Crypto.Crypto;
  const businessPortfolioId = yield* Config.schema(
    WhatsAppBusinessPortfolioId,
    "WHATSAPP_BUSINESS_PORTFOLIO_ID"
  );
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

    const unavailableOutcome = terminal
      .display(unavailableMessage)
      .pipe(Effect.as(Option.none<AgentConversationOutcome>()));
    const outcome = yield* handleAgentConversationTurn({
      caller: {
        businessPortfolioId,
        businessScopedUserId: caller.businessScopedUserId,
        parentBusinessScopedUserId: Option.none(),
        username: Option.none(),
        phoneNumber: Option.some(caller.phoneNumber),
      },
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
        ModelUnavailable: () => unavailableOutcome,
        ModelResponseRejected: () => unavailableOutcome,
        OnboardingConsentRequired: () => unavailableOutcome,
        UnknownUser: () => unavailableOutcome,
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
