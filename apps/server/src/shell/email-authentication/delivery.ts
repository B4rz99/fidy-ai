import { Config, Context, Data, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { HttpBody, HttpClient, type HttpClientResponse } from "effect/unstable/http";
import type { EmailAddress, EmailEnrollmentCombinedCode } from "~/core/email-authentication/model";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";

const subject = "Verifica tu correo en Fidy";
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const rateLimitedStatus = 429;
const serverErrorStatusMinimum = 500;

type VerificationEmail = Readonly<{ subject: string; text: string; html: string }>;

/** Immutable provider projection; only the fixed-format combined code varies. */
export const verificationEmail = (
  combinedCode: EmailEnrollmentCombinedCode
): VerificationEmail => ({
  subject,
  text: `Tu código de verificación es:\n\n${combinedCode}\n\nEscríbelo en https://fidyapp.com/auth/verify-email. Este código vence en 10 minutos.\n\nSi no solicitaste este correo, ignóralo.\n\nFidy nunca te pedirá este código por WhatsApp ni por soporte.`,
  html: `<p>Tu código de verificación es:</p><p><strong><code>${combinedCode}</code></strong></p><p>Escríbelo en <a href="https://fidyapp.com/auth/verify-email">https://fidyapp.com/auth/verify-email</a>. Este código vence en 10 minutos.</p><p>Si no solicitaste este correo, ignóralo.</p><p>Fidy nunca te pedirá este código por WhatsApp ni por soporte.</p>`,
});

export class EmailSendFailed extends Data.TaggedError("EmailSendFailed")<{
  readonly certainty: "rejected" | "ambiguous";
  readonly retryable: boolean;
}> {}

export type EmailDeliveryPortService = {
  readonly send: (input: {
    readonly to: EmailAddress;
    readonly combinedCode: EmailEnrollmentCombinedCode;
    readonly idempotencyKey: string;
  }) => Effect.Effect<void, EmailSendFailed>;
};

const maximumResendResponseBytes = 4096;
const maximumResendMessageIdLength = 128;
const ResendApiKey = Schema.String.check(Schema.isPattern(/^re_[A-Za-z0-9_-]{20,253}$/u)).annotate({
  identifier: "ResendApiKey",
});
const ResendSuccess = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumResendMessageIdLength)),
});
const decodeResendSuccess = Schema.decodeUnknownResult(ResendSuccess);
const decodeJson = Schema.decodeUnknownResult(Schema.UnknownFromJsonString);

const decodeBoundedResendResponse = Effect.fn("Resend.decodeBoundedResponse")(function* (
  response: HttpClientResponse.HttpClientResponse
) {
  const successful =
    response.status >= successfulStatusMinimum &&
    response.status < successfulStatusMaximumExclusive;
  const body = yield* collectBoundedBytes(response.stream, maximumResendResponseBytes).pipe(
    Effect.mapError(
      () =>
        new EmailSendFailed({ certainty: successful ? "ambiguous" : "rejected", retryable: false })
    )
  );
  if (Option.isNone(body)) {
    return yield* new EmailSendFailed({
      certainty: successful ? "ambiguous" : "rejected",
      retryable: false,
    });
  }
  const json = decodeJson(new TextDecoder().decode(body.value));
  if (Result.isFailure(json)) {
    return yield* new EmailSendFailed({
      certainty: successful ? "ambiguous" : "rejected",
      retryable: false,
    });
  }
  return json.success;
});

const ResendRequest = Schema.Struct({
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
  html: Schema.String,
});
const encodeResendRequest = Schema.encodeSync(Schema.fromJsonString(ResendRequest));

const classifyResendResponse = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<void, EmailSendFailed> =>
  Effect.flatMap(decodeBoundedResendResponse(response), (body) => {
    if (
      response.status >= successfulStatusMinimum &&
      response.status < successfulStatusMaximumExclusive
    ) {
      return Result.isSuccess(decodeResendSuccess(body))
        ? Effect.void
        : new EmailSendFailed({ certainty: "ambiguous", retryable: false });
    }
    const retryable =
      response.status === rateLimitedStatus || response.status >= serverErrorStatusMinimum;
    return new EmailSendFailed({ certainty: "rejected", retryable });
  });

export class EmailDeliveryPort extends Context.Service<
  EmailDeliveryPort,
  EmailDeliveryPortService
>()("@fidy/server/shell/email-authentication/delivery/EmailDeliveryPort") {
  static readonly layer = Layer.effect(
    EmailDeliveryPort,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
      if (environment !== "production") {
        return EmailDeliveryPort.of({
          send: () => new EmailSendFailed({ certainty: "rejected", retryable: false }),
        });
      }
      const apiKey = yield* Config.redacted("RESEND_API_KEY");
      yield* Config.schema(ResendApiKey, "RESEND_API_KEY");
      const fromEmail = yield* Config.schema(
        Schema.Literal("obarboza@fidyapp.com"),
        "RESEND_FROM_EMAIL"
      );
      const fromName = yield* Config.schema(Schema.Literal("Fidy"), "RESEND_FROM_NAME");
      return EmailDeliveryPort.of({
        send: (input) => {
          const projection = verificationEmail(input.combinedCode);
          return httpClient
            .post("https://api.resend.com/emails", {
              headers: {
                authorization: `Bearer ${Redacted.value(apiKey)}`,
                "content-type": "application/json",
                "idempotency-key": input.idempotencyKey,
              },
              body: HttpBody.text(
                encodeResendRequest({
                  from: `${fromName} <${fromEmail}>`,
                  to: [input.to],
                  subject: projection.subject,
                  text: projection.text,
                  html: projection.html,
                }),
                "application/json"
              ),
            })
            .pipe(
              Effect.timeout("14 seconds"),
              Effect.mapError(
                () => new EmailSendFailed({ certainty: "ambiguous", retryable: false })
              ),
              Effect.flatMap(classifyResendResponse)
            );
        },
      });
    })
  );
}
