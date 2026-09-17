import { UnknownJsonString, jsonStringSchema } from "../src/shell/schema-codecs/contract";
import { BunHttpClient, BunRuntime } from "@effect/platform-bun";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { OutboundHttp } from "~/shell/outbound-http/operations";

const maximumPairingCharacters = 16;
const maximumRecoveryCharacters = 40;
const failureExitCode = 1;
const refusalExitCode = 2;
const successMessage =
  "Recuperación aprobada. Vuelve de inmediato al mismo navegador donde iniciaste la vinculación y continúa allí. No cierres esa pantalla ni compartas información adicional del navegador con soporte.";
const refusalMessage =
  "No pudimos aprobar la recuperación. La información proporcionada o la vinculación no permiten continuar. Si aún conservas tu código de recuperación, inicia una nueva vinculación y vuelve a contactar a soporte. No envíes documentos, datos financieros ni números de tarjeta o cuenta.";
const unavailableMessage =
  "La operación de soporte no está disponible. No se tomó una decisión de recuperación. Escala el incidente por el canal interno.";

const SupportResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("approved"), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("not_approved"), message: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("limited"),
    message: Schema.String,
    retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), message: Schema.String }),
]);
type SupportResponse = typeof SupportResponse.Type;
const resultMessages: Readonly<Record<SupportResponse["status"], string>> = {
  approved: successMessage,
  not_approved: refusalMessage,
  limited: unavailableMessage,
  unavailable: unavailableMessage,
};

class SupportCliFailure extends Data.TaggedError("SupportCliFailure")<{
  readonly message: string;
}> {}

type InputAction =
  | Readonly<{ _tag: "Cancel" }>
  | Readonly<{ _tag: "Submit" }>
  | Readonly<{ _tag: "Continue"; value: string; erased: boolean; appended: string }>;

const applyInputCharacter = (value: string, character: string, maximum: number): InputAction => {
  if (character === "\u0003") return { _tag: "Cancel" };
  if (character === "\r" || character === "\n") return { _tag: "Submit" };
  if (character === "\u007f") {
    return {
      _tag: "Continue",
      value: value.slice(0, -1),
      erased: value.length > 0,
      appended: "",
    };
  }
  if (character < " " || value.length >= maximum) {
    return { _tag: "Continue", value, erased: false, appended: "" };
  }
  return { _tag: "Continue", value: `${value}${character}`, erased: false, appended: character };
};

const writeLine = (stream: NodeJS.WriteStream, message: string): Effect.Effect<void> =>
  Effect.sync(() => stream.write(`${message}\n`)).pipe(Effect.asVoid);

const readBoundedLine = Effect.fn("SupportRecoveryCli.readBoundedLine")(
  (prompt: string, maximum: number, echo: boolean) =>
    Effect.callback<string, SupportCliFailure>((resume) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        resume(
          Effect.fail(
            new SupportCliFailure({ message: "La entrada interactiva no está disponible." })
          )
        );
        return;
      }
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdout.write(prompt);
      let value = "";
      const cleanup = (): void => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
      };
      const finish = (effect: Effect.Effect<string, SupportCliFailure>): void => {
        cleanup();
        process.stdout.write("\n");
        resume(effect);
      };
      const onData = (chunk: string): void => {
        for (const character of chunk) {
          const action = applyInputCharacter(value, character, maximum);
          if (action._tag === "Cancel") {
            finish(Effect.fail(new SupportCliFailure({ message: "Operación cancelada." })));
            return;
          }
          if (action._tag === "Submit") {
            finish(Effect.succeed(value));
            return;
          }
          value = action.value;
          if (echo && action.erased) process.stdout.write("\b \b");
          if (echo && action.appended.length > 0) process.stdout.write(action.appended);
        }
      };
      process.stdin.on("data", onData);
      return Effect.sync(cleanup);
    })
);

const requireInteractiveTerminal = Effect.fn("SupportRecoveryCli.requireInteractiveTerminal")(
  function* () {
    if (process.stdin.isTTY && process.stdout.isTTY) return;
    return yield* new SupportCliFailure({ message: unavailableMessage });
  }
);

const readRecoveryInput = Effect.fn("SupportRecoveryCli.readInput")(function* () {
  yield* requireInteractiveTerminal();
  const pairingCode = yield* readBoundedLine(
    "Referencia pública de vinculación: ",
    maximumPairingCharacters,
    true
  );
  const backupRecoveryCode = yield* readBoundedLine(
    "Código de recuperación (entrada oculta): ",
    maximumRecoveryCharacters,
    false
  );
  return { pairingCode, backupRecoveryCode };
});

const callSupportRecovery = Effect.fn("SupportRecoveryCli.callTransport")(function* (
  input: Effect.Success<ReturnType<typeof readRecoveryInput>>
) {
  const body = yield* Schema.encodeEffect(UnknownJsonString)(input).pipe(
    Effect.mapError(
      () => new SupportCliFailure({ message: "La operación de soporte no está disponible." })
    )
  );
  const response = yield* (yield* OutboundHttp)
    .execute({ _tag: "CloudflareAccessSupportRecovery", body })
    .pipe(
      Effect.mapError(
        () => new SupportCliFailure({ message: "La operación de soporte no está disponible." })
      )
    );
  const decoded = Schema.decodeOption(jsonStringSchema(SupportResponse))(
    new TextDecoder().decode(response.body)
  );
  if (Option.isSome(decoded)) return decoded.value;
  return yield* new SupportCliFailure({
    message: "La operación devolvió una respuesta no válida.",
  });
});

const displayResult = Effect.fn("SupportRecoveryCli.displayResult")(function* (
  response: SupportResponse
) {
  yield* writeLine(process.stdout, resultMessages[response.status]);
  if (response.status === "limited") {
    yield* writeLine(process.stderr, `Reintenta en ${response.retryAfterSeconds} segundos.`);
  }
  if (response.status === "limited" || response.status === "unavailable") {
    process.exitCode = failureExitCode;
  }
  if (response.status === "not_approved") process.exitCode = refusalExitCode;
});

const program = Effect.gen(function* () {
  yield* requireInteractiveTerminal();
  const outboundContext = yield* Layer.build(OutboundHttp.cloudflareAccessLayer).pipe(
    Effect.mapError(
      () => new SupportCliFailure({ message: "La operación de soporte no está disponible." })
    )
  );
  const outboundHttp = Context.get(outboundContext, OutboundHttp);
  const input = yield* readRecoveryInput();
  const response = yield* callSupportRecovery(input).pipe(
    Effect.provideService(OutboundHttp, outboundHttp)
  );
  yield* displayResult(response);
}).pipe(
  Effect.catchTag("SupportCliFailure", () =>
    writeLine(process.stderr, unavailableMessage).pipe(
      Effect.tap(() => Effect.sync(() => (process.exitCode = failureExitCode)))
    )
  ),
  // This command is the application entry point that owns the HTTP client lifetime.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(BunHttpClient.layer)
);

BunRuntime.runMain(Effect.scoped(program));
