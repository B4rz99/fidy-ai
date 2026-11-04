import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Config, Effect, Layer, Schema } from "effect";
import { ProGrantEntry, ProGrantFailure } from "../../apps/server/src/shell/pro-grants/contract";
import { runProOperatorCommand } from "./runtime";

const usage =
  "Uso: bun run pro grant|revoke correo@example.com\n     bun run pro grant|revoke --user-id UUID\n     bun run pro list\nConfigura CLOUDFLARE_ACCOUNT_ID, FIDY_CORE_WORKER_NAME y FIDY_PRO_OPERATOR; autentica Wrangler con OAuth o CLOUDFLARE_API_TOKEN.\n";
const unavailable = (): ProGrantFailure =>
  new ProGrantFailure({ reason: "unavailable", candidates: [] });
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
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    process.stdout.write(usage);
    return;
  }
  const command = parseCommand(args);
  const config = yield* Config.all({
    accountId: Config.String("CLOUDFLARE_ACCOUNT_ID").pipe(Config.withDefault("")),
    coreWorkerName: Config.String("FIDY_CORE_WORKER_NAME").pipe(Config.withDefault("")),
    legacyDatabaseId: Config.option(Config.String("FIDY_DATABASE_ID")),
    operator: Config.String("FIDY_PRO_OPERATOR").pipe(Config.withDefault("")),
  }).pipe(Effect.mapError(unavailable));
  const result = yield* runProOperatorCommand({
    ...config,
    command,
  });
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ProGrantEntry)))(
    result
  ).pipe(Effect.mapError(unavailable));
  process.stdout.write(encoded + "\n");
}).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)), Effect.scoped);

await Effect.runPromise(
  program.pipe(
    Effect.catchTag("ProGrantFailure", (failure) =>
      Effect.sync(() => {
        const messages = {
          "invalid-input": usage,
          "user-not-found":
            "No se encontró un usuario con ese identificador o correo verificado. Verifica el correo en Ajustes > Cuenta o usa --user-id.\n",
          "ambiguous-email": "El correo coincide con varios usuarios. Usa --user-id.\n",
          unavailable:
            "No se pudo confirmar el resultado. Comprueba credenciales y configuración; consulta pro list antes de repetir un cambio.\n",
        };
        process.stderr.write(messages[failure.reason]);
        if (failure.candidates.length > 0) {
          process.stderr.write(failure.candidates.join("\n") + "\n");
        }
        process.exitCode = 1;
      })
    )
  )
);
