import { Context, Effect, Layer, Option, Redacted, Schema, Terminal } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { authenticateAccess, protectedHttpClient } from "../direct-client/runtime";
import {
  RecoveryFailure,
  RecoveryInput,
  type RecoveryOperator,
  type RecoveryOutcome,
  recoveryOperatorUrl,
} from "./contract";
import { readPrompt } from "./internal/prompt";

const maximumResponseBytes = 1024;

const maximumRequestBytes = 256;

const OutcomeBody = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literals(["approved", "not_approved", "unauthorized", "limited", "unavailable"]),
  })
);

const outcomes: Readonly<
  Record<typeof OutcomeBody.Type.status, Readonly<{ status: number; outcome: RecoveryOutcome }>>
> = {
  approved: { status: 200, outcome: "approved" },
  not_approved: { status: 400, outcome: "not_approved" },
  unauthorized: { status: 401, outcome: "unavailable" },
  limited: { status: 429, outcome: "unavailable" },
  unavailable: { status: 503, outcome: "unavailable" },
};

export const recoverySubmitter = (
  httpClient: HttpClient.HttpClient
): RecoveryOperator["submit"] => {
  const client = protectedHttpClient({
    client: httpClient,
    allowQuery: false,
    maximumResponseBytes,
    maximumRequestBytes,
    captureRetry: () => {},
    captureAllowance: () => {},
    captureTrace: () => {},
  });

  return Effect.fn(
    function* (input, assertion) {
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryInput))(input);

      const response = yield* client.execute(
        HttpClientRequest.post(recoveryOperatorUrl).pipe(
          HttpClientRequest.setHeader("cf-access-token", Redacted.value(assertion)),
          HttpClientRequest.bodyText(body, "application/json")
        )
      );

      const outcome = yield* Schema.decodeEffect(OutcomeBody)(yield* response.text);
      const reply = outcomes[outcome.status];

      return response.status === reply.status ? reply.outcome : "uncertain";
    },
    Effect.orElseSucceed((): RecoveryOutcome => "uncertain")
  );
};

const pairingCharacters = 9;

const recoveryCharacters = 29;

export const makeRecoveryOperator = Effect.fn(function* (
  httpClient: HttpClient.HttpClient,
  terminalOutput: Pick<RecoveryOperator, "interactive" | "write">
) {
  const terminal = yield* Terminal.Terminal;

  const operator: RecoveryOperator = {
    ...terminalOutput,
    authenticate: authenticateAccess(recoveryOperatorUrl).pipe(
      Effect.mapError(
        (cause) => new RecoveryFailure({ reason: "AccessUnavailable", cause: Option.some(cause) })
      )
    ),
    readPairing: readPrompt({
      terminal,
      write: terminalOutput.write,
      label: "Referencia pública del navegador: ",
      maximumCharacters: pairingCharacters,
    }),
    readCode: readPrompt({
      terminal,
      write: terminalOutput.write,
      label: "Código de recuperación (oculto): ",
      maximumCharacters: recoveryCharacters,
    }).pipe(Effect.map(Redacted.make)),
    submit: recoverySubmitter(httpClient),
  };

  return operator;
});

export class RecoveryOperatorService extends Context.Service<
  RecoveryOperatorService,
  RecoveryOperator
>()("@fidy/cli/support-recovery/runtime/RecoveryOperatorService") {
  static readonly make = Effect.gen(function* () {
    const terminalOutput = {
      interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
      write: (message: string): Effect.Effect<void> =>
        Effect.sync(() => {
          process.stderr.write(message);
        }),
    };

    return yield* makeRecoveryOperator(yield* HttpClient.HttpClient, terminalOutput);
  });

  static readonly layer = Layer.effect(this, this.make);
}
