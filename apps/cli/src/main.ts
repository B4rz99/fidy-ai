#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option, Path, Schema, Terminal } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { formatFailure, formatOutput, runCommand } from "./command/operations";
import { CliFailure } from "./credential/contract";
import { makeCredentialStore, supportedBunRevision } from "./credential/runtime";
import { makePairingClient } from "./direct-client/runtime";
import { runOperationCommand } from "./canonical/operations";
import { makeCanonicalClient, readOperationInput } from "./canonical/runtime";
import { runSupportRecovery } from "./support-recovery/operations";
import { makeRecoveryOperator } from "./support-recovery/runtime";

const args = Bun.argv.slice(2);
const json = args.includes("--json");
const commandArgs = args.filter((argument) => argument !== "--json");
const validateFlags = Effect.fn(function* () {
  if (args.filter((argument) => argument === "--json").length > 1) {
    return yield* new CliFailure({ reason: "InvalidInput" });
  }
  if (json && commandArgs.length === 1 && commandArgs[0] === "login") {
    return yield* new CliFailure({ reason: "InvalidInput" });
  }
});
const runOperator = Effect.fn(function* () {
  const operator = yield* makeRecoveryOperator(yield* HttpClient.HttpClient, {
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    write: (text) =>
      Effect.sync(() => {
        process.stderr.write(text);
      }),
  });
  if (yield* runSupportRecovery(args, operator)) process.exitCode = 1;
});
const program = Effect.gen(function* () {
  yield* validateFlags();
  if (commandArgs[0] === "support-recovery") {
    return yield* runOperator();
  }
  const home = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
    process.platform === "win32" ? Bun.env.USERPROFILE : Bun.env.HOME
  ).pipe(Effect.mapError(() => new CliFailure({ reason: "StorageUnavailable" })));
  const path = yield* Path.Path;
  if (!path.isAbsolute(home)) return yield* new CliFailure({ reason: "StorageUnavailable" });
  const credential = yield* makeCredentialStore(path.join(home, ".fidy", "cli"));
  const httpClient = yield* HttpClient.HttpClient;
  if (!["login", "status", "logout"].includes(commandArgs[0] ?? "")) {
    const failed = yield* runOperationCommand(commandArgs, {
      store: credential.store,
      httpClient,
      clientFactory: makeCanonicalClient,
      readInput: readOperationInput,
      stdout: (text) =>
        Effect.sync(() => {
          process.stdout.write(text);
        }),
      stderr: (text) =>
        Effect.sync(() => {
          process.stderr.write(text);
        }),
      json,
    });
    if (failed) process.exitCode = 1;
    return;
  }
  const pairing = yield* makePairingClient(httpClient);
  const terminal = yield* Terminal.Terminal;
  yield* runCommand(commandArgs, {
    ...credential,
    pairing,
    readLine: (question) =>
      (json
        ? Effect.sync(() => {
            process.stderr.write(question);
          })
        : terminal.display(question)
      ).pipe(
        Effect.andThen(terminal.readLine),
        Effect.mapError(
          (failure) =>
            new CliFailure({ reason: Terminal.isQuitError(failure) ? "Cancelled" : "InvalidInput" })
        )
      ),
    emit: (output) =>
      formatOutput(output, json).pipe(
        Effect.flatMap((text) =>
          Effect.sync(() => {
            process.stdout.write(text);
          })
        ),
        Effect.orDie
      ),
  });
}).pipe(Effect.scoped);
const interruptedExitCode = 130;

if (import.meta.main) {
  if (Bun.revision !== supportedBunRevision) {
    process.stderr.write(formatFailure({ reason: "UnsupportedRuntime", json }));
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    const interrupt = (): void => {
      controller.abort();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
      { signal: controller.signal }
    );
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      const reason =
        Option.isSome(failure) && failure.value instanceof CliFailure
          ? failure.value.reason
          : "TransportUnavailable";
      const interrupted = Cause.hasInterrupts(exit.cause) || reason === "Cancelled";
      process.stderr.write(
        commandArgs[0] === "support-recovery"
          ? "Proceso de recuperación interrumpido o no disponible. Si ya enviaste la solicitud, comprueba la vinculación en el mismo navegador; no repitas una decisión incierta ni compartas secretos.\n"
          : formatFailure({ reason: interrupted ? "Cancelled" : reason, json })
      );
      process.exitCode = interrupted ? interruptedExitCode : 1;
    }
  }
}
