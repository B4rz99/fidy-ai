import { Effect, Redacted, Schema, Terminal } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { makeProtectedClient } from "../direct-client/runtime";
import {
  RecoveryInput,
  type RecoveryOperator,
  type RecoveryOutcome,
  recoveryOperatorUrl,
} from "./contract";
import { authenticateAccess } from "./internal/access";
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

/** Fixed private Access transport. Loss or invalid delivery is uncertain and is never retried. */
export const makeRecoveryClient = (
  httpClient: HttpClient.HttpClient
): RecoveryOperator["submit"] => {
  const client = makeProtectedClient({
    client: httpClient,
    allowQuery: false,
    maximumResponseBytes,
    maximumRequestBytes,
    captureRetry: () => {},
    captureAllowance: () => {},
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

/** Constructs private operator ports. It reads no PAT, home directory or claimant proof from env. */
export const makeRecoveryOperator = Effect.fn(function* (
  httpClient: HttpClient.HttpClient,
  terminalOutput: Pick<RecoveryOperator, "interactive" | "write">
) {
  const terminal = yield* Terminal.Terminal;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const operator: RecoveryOperator = {
    ...terminalOutput,
    authenticate: authenticateAccess.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
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
    submit: makeRecoveryClient(httpClient),
  };
  return operator;
});
