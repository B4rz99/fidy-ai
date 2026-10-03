// Broad test composition only. Production main never imports this loopback/native-store fixture.
import { BunServices } from "@effect/platform-bun";
import { FidyApi, makeTokenAuthorizationClientLive } from "@fidy/server/client";
import { Cause, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { formatOutput, runCommand } from "../src/command/operations";
import { CliFailure, type NativeSecrets, apiOrigin } from "../src/credential/contract";
import { makeCredentialStore } from "../src/credential/runtime";
import { makePairingClient, protectClient } from "../src/direct-client/runtime";

const metadata = Schema.decodeUnknownSync(Schema.NonEmptyString)(Bun.env.CLI_JOURNEY_DIRECTORY);
const nativeService = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^com\.fidy\.cli\.journey\.[a-z0-9-]+$/u))
)(Bun.env.CLI_JOURNEY_SERVICE);
const unavailable = (): CliFailure => new CliFailure({ reason: "StorageUnavailable" });
const native: NativeSecrets = {
  get: (name) =>
    Effect.tryPromise({
      try: () => Bun.secrets.get({ service: nativeService, name }),
      catch: unavailable,
    }).pipe(Effect.map((value) => Option.map(Option.fromNullOr(value), Redacted.make))),
  set: (name, value) => {
    const options = {
      service: nativeService,
      name,
      value: Redacted.value(value),
      persist: "local",
    } as const;
    return Effect.tryPromise({ try: () => Bun.secrets.set(options), catch: unavailable });
  },
  delete: (name) =>
    Effect.tryPromise({
      try: () => Bun.secrets.delete({ service: nativeService, name }),
      catch: unavailable,
    }).pipe(Effect.asVoid),
};
const acceptanceMode = Schema.decodeUnknownSync(Schema.Literals(["shared", "cli"]))(
  Bun.env.CLI_ACCEPTANCE_MODE ?? "shared"
);
const loopbackOrigin =
  acceptanceMode === "cli" ? "https://127.0.0.1:4184" : "https://127.0.0.1:4174";
const program = Effect.gen(function* () {
  if (Bun.argv[2] === "cleanup") {
    return yield* native.delete("login").pipe(Effect.andThen(native.delete("storage-probe")));
  }
  const original = yield* FetchHttpClient.Fetch;
  const loopback = Object.assign(
    (input: Parameters<typeof original>[0], init?: RequestInit): Promise<Response> => {
      const source = input instanceof Request ? input.url : input.toString();
      const url = new URL(source);
      if (url.origin !== apiOrigin) {
        return Promise.reject(new CliFailure({ reason: "TransportUnavailable" }));
      }
      return original(`${loopbackOrigin}${url.pathname}`, {
        ...init,
        tls: { rejectUnauthorized: false },
      });
    },
    { preconnect: original.preconnect }
  );
  const http = yield* HttpClient.HttpClient;
  const credentials = yield* makeCredentialStore(metadata, native);
  const pairing = yield* makePairingClient(http);
  const command = Bun.argv.slice(2);
  const execute =
    command[0] === "reuse"
      ? Effect.gen(function* () {
          const saved = yield* credentials.store.load;
          if (Option.isNone(saved)) return yield* new CliFailure({ reason: "StorageInconsistent" });
          const client = yield* HttpApiClient.makeWith(FidyApi, {
            httpClient: protectClient(http),
            baseUrl: apiOrigin,
          }).pipe(
            Effect.provide(makeTokenAuthorizationClientLive(Redacted.value(saved.value.bearer)))
          );
          const result = yield* client.categories.listCategories({});
          if (result.data.length === 0) {
            return yield* new CliFailure({ reason: "DependencyUnavailable" });
          }
          yield* Effect.sync(() => {
            process.stdout.write("Credencial reutilizada en una consulta autorizada.\n");
          });
        })
      : runCommand(command, {
          ...credentials,
          pairing,
          readLine: () => Effect.fail(new CliFailure({ reason: "InvalidInput" })),
          emit: (output) =>
            formatOutput(output, true).pipe(
              Effect.flatMap((text) =>
                Effect.sync(() => {
                  process.stdout.write(text);
                })
              ),
              Effect.orDie
            ),
        });
  yield* execute.pipe(Effect.provideService(FetchHttpClient.Fetch, loopback));
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)));
const controller = new AbortController();
const interrupt = (): void => {
  controller.abort();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const exit = await Effect.runPromiseExit(program, { signal: controller.signal });
process.removeListener("SIGINT", interrupt);
process.removeListener("SIGTERM", interrupt);
if (Exit.isFailure(exit)) {
  const failure = Cause.findErrorOption(exit.cause);
  process.stderr.write(
    Option.isSome(failure) && failure.value instanceof CliFailure
      ? failure.value.reason + "\n"
      : "JourneyFailed\n"
  );
  process.exitCode = 1;
}
