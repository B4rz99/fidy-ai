import {
  ErasureCaseCommand,
  ErasureOperatorReceipt,
  StorageCommand,
  StoreObservation,
  storageOperatorPath,
} from "@fidy/server/storage-operations";
import { Effect, Redacted, Schema, Terminal } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { CliFailure, apiOrigin } from "../credential/contract";
import { authenticateAccess, makeProtectedClient } from "../direct-client/runtime";

const redirectStatus = 300;
const okStatus = 200;
const serverFailure = 500;
const maximumCommandBytes = 1024;

const inputFailure = (): CliFailure => new CliFailure({ reason: "InvalidInput" });
const ambiguous = (): CliFailure => new CliFailure({ reason: "MutationAmbiguous" });
const invalidResponse = (): CliFailure => new CliFailure({ reason: "TransportUnavailable" });
const acceptedStatus = 202;
const operatorClient = Effect.gen(function* () {
  return makeProtectedClient({
    client: yield* HttpClient.HttpClient,
    allowQuery: false,
    maximumRequestBytes: 1024,
    maximumResponseBytes: 4096,
    captureRetry: () => {},
    captureAllowance: () => {},
    captureTrace: () => {},
  });
});
/** Human-only transport. The opaque target stays out of shell history and the saved Fidy credential is never loaded. */
export const runStorageOperator = Effect.fn(function* (
  args: ReadonlyArray<string>,
  terminalOutput: { interactive: boolean; write: (message: string) => Effect.Effect<void> }
) {
  if (args.length !== 1 || !terminalOutput.interactive) return yield* inputFailure();
  const terminal = yield* Terminal.Terminal;
  yield* terminalOutput.write("Enter the private command as one JSON object: ");
  const line = yield* terminal.readLine.pipe(Effect.mapError(inputFailure));
  if (line.length > maximumCommandBytes) return yield* inputFailure();
  const command = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Union([StorageCommand, ErasureCaseCommand])),
    { onExcessProperty: "error" }
  )(line).pipe(Effect.mapError(inputFailure));
  const erasure = command.action === "Continue" || command.action === "Receipt";
  const url = erasure
    ? (`${apiOrigin}/internal/titular-erasure` as const)
    : (`${apiOrigin}${storageOperatorPath}` as const);
  const client = yield* operatorClient;
  const assertion = yield* authenticateAccess(url);
  const submitted = (): CliFailure =>
    command.action.startsWith("inspect") || command.action === "Receipt"
      ? invalidResponse()
      : ambiguous();
  yield* Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(command).pipe(
      Effect.mapError(inputFailure)
    );
    const response = yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("cf-access-token", Redacted.value(assertion)),
          HttpClientRequest.bodyText(body, "application/json")
        )
      )
      .pipe(Effect.timeout("15 seconds"), Effect.mapError(submitted));
    if (response.status >= serverFailure) return yield* submitted();
    if (response.status < okStatus || response.status >= redirectStatus) {
      return yield* new CliFailure({ reason: "OperationUnavailable" });
    }
    if (command.action === "Continue" && response.status === acceptedStatus) {
      return yield* terminalOutput.write("Continuation accepted. Read the same case receipt.\n");
    }
    const payload = yield* response.text.pipe(Effect.mapError(submitted));
    const result = yield* Schema.decodeEffect(
      Schema.fromJsonString(erasure ? ErasureOperatorReceipt : StoreObservation),
      { onExcessProperty: "error" }
    )(payload).pipe(Effect.mapError(submitted));
    yield* terminalOutput.write(
      (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result).pipe(
        Effect.mapError(submitted)
      )) + "\n"
    );
  }).pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(assertion))));
});
