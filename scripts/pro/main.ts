import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { BunServices } from "@effect/platform-bun";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

import {
  ProCommand,
  ProGrantEntry,
  ProGrantFailure,
} from "../../apps/server/src/shell/pro-grants/contract";
import { makeProClient, runProCommand } from "./runtime";

const usage =
  "Uso: bun run pro grant|revoke correo@example.com\n     bun run pro grant|revoke --user-id UUID\n     bun run pro list\nAutentícate con cloudflared y la cuenta autorizada para la beta.\n";

const unavailable = (): ProGrantFailure => new ProGrantFailure({ reason: "unavailable" });

const parseCommand = (args: ReadonlyArray<string>): unknown => {
  const action = args[0];

  if (action === "list" && args.length === 1) return { action };

  if (action !== "grant" && action !== "revoke") return {};

  if (args.length === 2) return { action, selector: { email: args[1] } };

  if (args.length === 3 && args[1] === "--user-id") {
    return { action, selector: { userId: args[2] } };
  }

  return {};
};

const program = Effect.gen(function* () {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    process.stdout.write(usage);

    return;
  }

  const command = yield* Schema.decodeUnknownEffect(ProCommand)(parseCommand(args)).pipe(
    Effect.mapError(() => new ProGrantFailure({ reason: "invalid-input" }))
  );

  const result = yield* runProCommand(command, yield* makeProClient());

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ProGrantEntry)))(
    result
  ).pipe(Effect.mapError(unavailable));

  process.stdout.write(encoded + "\n");
}).pipe(Effect.scoped);

if (import.meta.main) {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, SecureRandom.layerWebCrypto)
  );

  try {
    await runtime.runPromise(
      program.pipe(
        Effect.catchTag("ProGrantFailure", (failure) =>
          Effect.sync(() => {
            const messages = {
              "invalid-input": usage,
              "user-not-found":
                "No se encontró un usuario con ese identificador o correo verificado. Verifica el correo en Ajustes > Cuenta o usa --user-id.\n",
              denied: "Cloudflare Access no autorizó esta cuenta para administrar la beta.\n",
              conflict: "El identificador de la solicitud ya corresponde a otra decisión.\n",
              unavailable:
                "No se pudo confirmar el resultado. Comprueba credenciales y configuración; consulta pro list antes de repetir un cambio.\n",
            };

            process.stderr.write(messages[failure.reason]);
            process.exitCode = 1;
          })
        )
      )
    );
  } finally {
    await runtime.dispose();
  }
}
