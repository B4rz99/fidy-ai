import { Effect, Redacted, Schema } from "effect";
import { executeProCommand } from "../../apps/server/src/shell/pro-grants/operations";
import { ProGrantEntry, ProGrantFailure } from "../../apps/server/src/shell/pro-grants/contract";
import { makeProQuery } from "./runtime";

const usage =
  "Uso: bun run pro grant|revoke correo@example.com\n     bun run pro grant|revoke --user-id UUID\n     bun run pro list\nConfigura CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, FIDY_DATABASE_ID y FIDY_PRO_OPERATOR.\n";
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
  const args = Bun.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    process.stdout.write(usage);
    return;
  }
  const command = parseCommand(args);
  const token = Redacted.make(Bun.env.CLOUDFLARE_API_TOKEN ?? "");
  yield* Effect.addFinalizer(() => Effect.sync(() => Redacted.wipeUnsafe(token)));
  const query = yield* makeProQuery({
    accountId: Bun.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: Bun.env.FIDY_DATABASE_ID ?? "",
    token,
  });
  const result = yield* executeProCommand({
    command,
    operator: Bun.env.FIDY_PRO_OPERATOR ?? "",
    query,
  });
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ProGrantEntry)))(
    result
  ).pipe(Effect.mapError(unavailable));
  process.stdout.write(encoded + "\n");
}).pipe(Effect.scoped);

if (import.meta.main) {
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
}
