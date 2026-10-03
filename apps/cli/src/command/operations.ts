import { PATScope, patLifetimeDayOptions } from "@fidy/server/client";
import { DateTime, Effect, Option, Schema } from "effect";
import { CliFailure } from "../credential/contract";
import { login } from "../login/operations";
import { type CommandDependencies, PublicOutput } from "./contract";
import { failures, messages } from "./internal/presentation";

const maximumArguments = 9;
const maximumArgumentCharacters = 256;
const Arguments = Schema.Array(
  Schema.String.check(Schema.isMaxLength(maximumArgumentCharacters))
).check(Schema.isMaxLength(maximumArguments));

const loginInput = Effect.fn(function* (
  args: ReadonlyArray<string>,
  dependencies: CommandDependencies
) {
  if (args.length === 1) {
    const recipientLabel = yield* dependencies.readLine("Destinatario exacto: ");
    const scopes = (yield* dependencies.readLine(
      `Permisos (${PATScope.literals.join(", ")}; separados por coma): `
    )).split(",");
    const lifetimeDays = Number(
      yield* dependencies.readLine(`Duración fija en días (${patLifetimeDayOptions.join(", ")}): `)
    );
    return { recipientLabel, scopes, lifetimeDays };
  }
  if (
    args.length !== flagArgumentCount ||
    args[1] !== "--recipient" ||
    args[3] !== "--scopes" ||
    args[5] !== "--lifetime"
  ) {
    return yield* new CliFailure({ reason: "InvalidInput" });
  }
  return { recipientLabel: args[2], scopes: args[4]?.split(","), lifetimeDays: Number(args[6]) };
});
const flagArgumentCount = 7;

const showStatus = Effect.fn(function* (dependencies: CommandDependencies) {
  const local = yield* dependencies.store.load;
  const now = yield* DateTime.now;
  if (Option.isNone(local)) {
    return yield* dependencies.emit({
      _tag: "LocalStatus",
      availability: "absent",
    });
  }
  const availability =
    local.value.grant.pat.expiresAt.epochMilliseconds <= now.epochMilliseconds
      ? "expired"
      : "available";
  yield* dependencies.emit({
    _tag: "LocalStatus",
    availability,
    grant: local.value.grant,
  });
});

/** Spanish presentation over local access and the one deep pairing operation; no domain commands. */
export const runCommand = Effect.fn(function* (input: unknown, dependencies: CommandDependencies) {
  const args = yield* Schema.decodeUnknownEffect(Arguments)(input).pipe(
    Effect.mapError(() => new CliFailure({ reason: "InvalidInput" }))
  );
  switch (args[0]) {
    case "login": {
      const request = yield* loginInput(args, dependencies);
      const grant = yield* login(request, dependencies.emit, dependencies);
      return yield* dependencies.emit({ _tag: "LoggedIn", grant });
    }
    case "status": {
      if (args.length !== 1) return yield* new CliFailure({ reason: "InvalidInput" });
      return yield* showStatus(dependencies);
    }
    case "logout": {
      if (args.length !== 1) return yield* new CliFailure({ reason: "InvalidInput" });
      yield* dependencies.store.clear;
      return yield* dependencies.emit({ _tag: "LoggedOut" });
    }
    case undefined:
    default:
      return yield* new CliFailure({ reason: "InvalidInput" });
  }
});

const outputCodec = Schema.fromJsonString(Schema.toCodecJson(PublicOutput));
const hexadecimalRadix = 16;
const escapeTerminalControls = (text: string): string =>
  text.replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(hexadecimalRadix).padStart(4, "0")}`
  );

/** Projects through the safe output schema; JSON escaping also protects human terminal output. */
export const formatOutput = Effect.fn(function* (output: PublicOutput, json: boolean) {
  const text = escapeTerminalControls(yield* Schema.encodeEffect(outputCodec)(output));
  return json ? `${text}\n` : `${messages[output._tag]}\n${text}\n`;
});

/** Failure text is selected from closed local reasons, never an arbitrary exception or Cause. */
export const formatFailure = ({
  reason,
  json,
}: Readonly<{ reason: CliFailure["reason"]; json: boolean }>): string => {
  const message = failures[reason];
  return json
    ? Schema.encodeSync(
        Schema.fromJsonString(Schema.Struct({ code: Schema.String, message: Schema.String }))
      )({ code: reason, message }) + "\n"
    : message + "\n";
};
