import { SampleReviewCommand, SampleReviewResult, sampleReviewPath } from "@fidy/server/client";
import { Effect, Redacted, Schema, Terminal } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { CliFailure, apiOrigin } from "../credential/contract";
import { authenticateAccess, makeProtectedClient } from "../direct-client/runtime";
import type { Reviewer } from "./operations";

const url = `${apiOrigin}${sampleReviewPath}` as const;

const maxRequestBytes = 1024;

const okStatus = 200;

const serverErrorStatus = 500;

const maxReplyBytes = 2048;

export const makeReviewer = Effect.fn(function* (
  terminalOutput: Pick<Reviewer, "interactive" | "write">
) {
  const terminal = yield* Terminal.Terminal;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const client = makeProtectedClient({
    client: yield* HttpClient.HttpClient,
    allowQuery: false,
    maximumRequestBytes: maxRequestBytes,
    maximumResponseBytes: maxReplyBytes,
    captureRetry: () => {},
    captureAllowance: () => {},
    captureTrace: () => {},
  });

  const reviewer: Reviewer = {
    ...terminalOutput,
    read: (prompt) =>
      terminalOutput.write(prompt).pipe(
        Effect.andThen(terminal.readLine),
        Effect.mapError(() => new CliFailure({ reason: "Cancelled" }))
      ),
    authenticate: authenticateAccess(url).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
    ),
    submit: Effect.fn(function* (command, assertion) {
      const uncertain = (): CliFailure =>
        new CliFailure({
          reason: command.action === "preview" ? "TransportUnavailable" : "MutationAmbiguous",
        });

      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SampleReviewCommand))(
        command
      ).pipe(Effect.mapError(uncertain));

      const response = yield* client
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("cf-access-token", Redacted.value(assertion)),
            HttpClientRequest.bodyText(encoded, "application/json")
          )
        )
        .pipe(Effect.mapError(uncertain));

      if (response.status !== okStatus) {
        return yield* response.status < serverErrorStatus
          ? new CliFailure({ reason: "OperationUnavailable" })
          : uncertain();
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(SampleReviewResult), {
        onExcessProperty: "error",
      })(yield* response.text.pipe(Effect.mapError(uncertain))).pipe(Effect.mapError(uncertain));
    }),
  };

  return reviewer;
});
