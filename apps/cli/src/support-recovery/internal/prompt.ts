import { Effect, Option, Queue, type Terminal } from "effect";
import { RecoveryFailure, type RecoveryOperator } from "../contract";

const editInput = Effect.fn(function* (text: string, event: Terminal.UserInput) {
  if (event.key.ctrl || event.key.meta) {
    return yield* new RecoveryFailure({ reason: "Cancelled", cause: Option.none() });
  }

  if (event.key.name === "backspace") return text.slice(0, -1);

  if (Option.isNone(event.input)) return text;

  if (!/^[A-Z0-9-]+$/u.test(event.input.value)) {
    return yield* new RecoveryFailure({ reason: "InvalidInput", cause: Option.none() });
  }

  return text + event.input.value;
});

export const readPrompt = Effect.fn(
  function* ({
    terminal,
    write,
    label,
    maximumCharacters,
  }: Readonly<{
    terminal: Terminal.Terminal;
    write: RecoveryOperator["write"];
    label: string;
    maximumCharacters: number;
  }>) {
    yield* write(label);
    const events = yield* terminal.readInput;
    let text = "";

    const next = Queue.take(events).pipe(
      Effect.mapError(
        (cause) => new RecoveryFailure({ reason: "Cancelled", cause: Option.some(cause) })
      )
    );

    let event = yield* next;

    while (event.key.name !== "return" && event.key.name !== "enter") {
      text = yield* editInput(text, event);

      if (text.length > maximumCharacters) {
        return yield* new RecoveryFailure({ reason: "InvalidInput", cause: Option.none() });
      }

      event = yield* next;
    }

    return text;
  },
  Effect.scoped,
  (effect, input) => effect.pipe(Effect.ensuring(input.write("\n")))
);
