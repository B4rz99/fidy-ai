import { Effect, Layer, Option, Schema } from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

import {
  ProCommand,
  ProGrantEntry,
  ProGrantFailure,
} from "../../apps/server/src/shell/pro-grants/contract";
import { ProClient, runProCommand } from "./runtime";

const usage =
  "Uso: bun run pro grant|revoke correo@example.com\n     bun run pro grant|revoke --user-id UUID\n     bun run pro list\nAutentícate con cloudflared y la cuenta autorizada para la beta.\n";

const unavailable = (): ProGrantFailure => new ProGrantFailure({ reason: "unavailable" });

const decodeCommand = Schema.decodeUnknownOption(ProCommand);

const parseCommand = (args: ReadonlyArray<string>): Option.Option<ProCommand> => {
  const action = args[0];

  if (action === "list" && args.length === 1) return decodeCommand({ action });

  if (action !== "grant" && action !== "revoke") return Option.none();

  if (args.length === 2) return decodeCommand({ action, selector: { email: args[1] } });

  if (args.length === 3 && args[1] === "--user-id") {
    return decodeCommand({ action, selector: { userId: args[2] } });
  }

  return Option.none();
};

const failureMessages: Readonly<Record<ProGrantFailure["reason"], string>> = {
  "invalid-input": usage,
  "user-not-found":
    "No se encontró un usuario con ese identificador o correo verificado. Verifica el correo en Ajustes > Cuenta o usa --user-id.\n",
  denied: "Cloudflare Access no autorizó esta cuenta para administrar la beta.\n",
  conflict: "El identificador de la solicitud ya corresponde a otra decisión.\n",
  unavailable:
    "No se pudo confirmar el resultado. Comprueba credenciales y configuración; consulta pro list antes de repetir un cambio.\n",
};

const reportFailure = (reason: ProGrantFailure["reason"]): void => {
  process.stderr.write(failureMessages[reason]);
  process.exitCode = 1;
};

const program = Effect.fn(function* (command: ProCommand) {
  const { submit } = yield* ProClient;
  const result = yield* runProCommand(command, submit);

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ProGrantEntry)))(
    result
  ).pipe(Effect.mapError(unavailable));

  process.stdout.write(encoded + "\n");
});

const layer = ProClient.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, SecureRandom.layerWebCrypto)
  )
);

if (import.meta.main) {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    process.stdout.write(usage);
  } else {
    Option.match(parseCommand(args), {
      onNone: () => reportFailure("invalid-input"),
      onSome: (command) =>
        BunRuntime.runMain(
          program(command).pipe(
            Effect.catchTag("ProGrantFailure", (failure) =>
              Effect.sync(() => reportFailure(failure.reason))
            ),
            Effect.provide(layer)
          )
        ),
    });
  }
}
