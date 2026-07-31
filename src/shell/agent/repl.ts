import { Effect, Option, Schema, Terminal } from "effect";
import type { UserId } from "~/core/_shared/user";
import { type AgentReply, AgentService, InboundMessage } from "./agent-service";

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

/**
 * Runs repeated turns for the stable User identified by `userId` until Terminal
 * reports quit. Each valid line invokes AgentService; invalid lines and turn
 * failures are rendered without ending the loop, and reply control characters
 * are neutralized before display. Terminal read/display failures remain typed
 * effects for the caller to handle.
 */
export const runAgentRepl = Effect.fn("runAgentRepl")(function* (userId: UserId) {
  const terminal = yield* Terminal.Terminal;
  const service = yield* AgentService;
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

    const reply = yield* service.handleTurn(userId, message.value).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        ModelUnavailable: () =>
          terminal.display(unavailableMessage).pipe(Effect.as(Option.none<AgentReply>())),
        UnknownUser: () =>
          terminal.display(unavailableMessage).pipe(Effect.as(Option.none<AgentReply>())),
      })
    );
    if (Option.isSome(reply)) {
      yield* terminal.display(`${renderTerminalText(reply.value.text)}\n`);
    }
  });

  yield* turn.pipe(
    Effect.forever,
    Effect.catchIf(Terminal.isQuitError, () => Effect.void)
  );
});
