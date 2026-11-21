import { SampleReviewCommand, SampleReviewResult, sampleReviewPath } from "@fidy/server/client";
import { Context, Effect, Layer, Option, Redacted, Schema, Terminal } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { CliFailure, apiOrigin } from "../credential/contract";
import { authenticateAccess, protectedHttpClient } from "../direct-client/runtime";
import type { Reviewer } from "./operations";

const url = `${apiOrigin}${sampleReviewPath}` as const;

const maxRequestBytes = 1024;

const okStatus = 200;

const serverErrorStatus = 500;

const maxReplyBytes = 2048;

export class SampleReviewer extends Context.Service<SampleReviewer, Reviewer>()(
  "@fidy/cli/sample-review/runtime/SampleReviewer"
) {
  static readonly make = Effect.gen(function* () {
    const terminalOutput = {
      interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
      write: (message: string): Effect.Effect<void> =>
        Effect.sync(() => {
          process.stderr.write(message);
        }),
    };

    const terminal = yield* Terminal.Terminal;

    const client = protectedHttpClient({
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
          Effect.mapError(
            (cause) => new CliFailure({ reason: "Cancelled", cause: Option.some(cause) })
          ),
          Effect.withSpan("SampleReviewer.read")
        ),
      authenticate: authenticateAccess(url),
      submit: Effect.fn("SampleReviewer.submit")(function* (command, assertion) {
        const uncertain = (): CliFailure =>
          new CliFailure({
            reason: command.action === "preview" ? "TransportUnavailable" : "MutationAmbiguous",
            cause: Option.none(),
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
            ? new CliFailure({ reason: "OperationUnavailable", cause: Option.none() })
            : uncertain();
        }

        return yield* Schema.decodeEffect(Schema.fromJsonString(SampleReviewResult), {
          onExcessProperty: "error",
        })(yield* response.text.pipe(Effect.mapError(uncertain))).pipe(Effect.mapError(uncertain));
      }),
    };

    return reviewer;
  });

  static readonly layer = Layer.effect(this, this.make);
}
