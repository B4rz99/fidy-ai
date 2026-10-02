import {
  ResendAccepted,
  makeOperatorEmailClient,
  operatorEmailBody,
  redirectStatus,
  successStatus,
} from "./internal/operator-email";
import { Effect, Result, Schema } from "effect";
import type { OperationalAlert } from "./contract";

/** Sends only closed operator metadata over the existing bounded Resend transport. */
export const sendOperatorEmail = (
  input: Readonly<{
    alert: OperationalAlert;
    idempotencyKey: string;
    to: string;
    apiKey: string;
    release: string;
    phase: "firing" | "resolved";
    signal: AbortSignal;
  }>
): Promise<void> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const outbound = yield* makeOperatorEmailClient(input);
        const body = yield* operatorEmailBody(input);
        return yield* outbound.execute({
          _tag: "ResendEmailDelivery",
          idempotencyKey: input.idempotencyKey,
          body,
        });
      })
    ),
    { signal: input.signal }
  ).then((result): void => {
    if (result._tag === "Failure") throw new Error("Operator email delivery unavailable");
    const response = result.value;
    if (
      response.status < successStatus ||
      response.status >= redirectStatus ||
      Result.isFailure(
        Schema.decodeResult(Schema.fromJsonString(ResendAccepted))(
          new TextDecoder().decode(response.body)
        )
      )
    ) {
      throw new Error("Operator email delivery unavailable");
    }
  });
