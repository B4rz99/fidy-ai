import { UnknownJsonString, jsonStringSchema } from "~/schema-compatibility";
import { Config, Context, Data, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type {
  EmailAddress,
  EmailProofPurpose,
  EmailVerificationCode,
} from "~/core/email-authentication/model";
import {
  type BoundedExternalHttpResponse,
  type ExternalHttpFailure,
  makeBoundedExternalHttpClient,
} from "~/shell/_shared/bounded-external-http";

const onboardingSubject = "Verifica tu correo en Fidy";
const replacementSubject = "Verifica tu nuevo correo en Fidy";
const browserPairingSubject = "Tu código para iniciar sesión en Fidy";
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const rateLimitedStatus = 429;
const serverErrorStatusMinimum = 500;

type VerificationEmail = Readonly<{ subject: string; text: string; html: string }>;

/** Immutable provider projection; only the fixed-format combined code varies. */
export const verificationEmail = (combinedCode: EmailVerificationCode): VerificationEmail => ({
  subject: onboardingSubject,
  text: `Tu código de verificación es:\n\n${combinedCode}\n\nEscríbelo en https://fidyapp.com/auth/verify-email. Este código vence en 10 minutos.\n\nSi no solicitaste este correo, ignóralo.\n\nFidy nunca te pedirá este código por WhatsApp ni por soporte.`,
  html: `<p>Tu código de verificación es:</p><p><strong><code>${combinedCode}</code></strong></p><p>Escríbelo en <a href="https://fidyapp.com/auth/verify-email">https://fidyapp.com/auth/verify-email</a>. Este código vence en 10 minutos.</p><p>Si no solicitaste este correo, ignóralo.</p><p>Fidy nunca te pedirá este código por WhatsApp ni por soporte.</p>`,
});

/** Fixed replacement projection; the schema-bounded code is its only variable content. */
export const replacementVerificationEmail = (
  combinedCode: EmailVerificationCode
): VerificationEmail => ({
  subject: replacementSubject,
  text: `Tu código para cambiar el correo de acceso a Fidy es:\n\n${combinedCode}\n\nEscríbelo en https://fidyapp.com/settings/email. Este código vence en 10 minutos.\n\nSi no solicitaste este cambio, ignora este correo. Tu correo actual seguirá funcionando.\n\nFidy nunca te pedirá este código por WhatsApp ni por soporte.`,
  html: `<p>Tu código para cambiar el correo de acceso a Fidy es:</p><p><strong><code>${combinedCode}</code></strong></p><p>Escríbelo en <a href="https://fidyapp.com/settings/email">https://fidyapp.com/settings/email</a>. Este código vence en 10 minutos.</p><p>Si no solicitaste este cambio, ignora este correo. Tu correo actual seguirá funcionando.</p><p>Fidy nunca te pedirá este código por WhatsApp ni por soporte.</p>`,
});

/** Fixed login projection; no pairing identity, mailbox, or verifier enters provider content. */
export const browserPairingVerificationEmail = (
  combinedCode: EmailVerificationCode
): VerificationEmail => ({
  subject: browserPairingSubject,
  text: `Tu código para iniciar sesión en Fidy es:\n\n${combinedCode}\n\nEscríbelo en https://fidyapp.com/auth/pair. Este código vence cuando termine la vinculación actual del navegador, como máximo 10 minutos después de iniciarla.\n\nSi no solicitaste este correo, ignóralo.\n\nFidy nunca te pedirá este código por WhatsApp ni por soporte.`,
  html: `<p>Tu código para iniciar sesión en Fidy es:</p><p><strong><code>${combinedCode}</code></strong></p><p>Escríbelo en <a href="https://fidyapp.com/auth/pair">https://fidyapp.com/auth/pair</a>. Este código vence cuando termine la vinculación actual del navegador, como máximo 10 minutos después de iniciarla.</p><p>Si no solicitaste este correo, ignóralo.</p><p>Fidy nunca te pedirá este código por WhatsApp ni por soporte.</p>`,
});

const verificationEmailByPurpose: Readonly<
  Record<EmailProofPurpose, (combinedCode: EmailVerificationCode) => VerificationEmail>
> = {
  "verified-onboarding": verificationEmail,
  "credential-replacement": replacementVerificationEmail,
  "browser-pairing-approval": browserPairingVerificationEmail,
};

const verificationEmailFor = (
  purpose: EmailProofPurpose,
  combinedCode: EmailVerificationCode
): VerificationEmail => verificationEmailByPurpose[purpose](combinedCode);

export class EmailSendFailed extends Data.TaggedError("EmailSendFailed")<{
  readonly certainty: "rejected" | "ambiguous";
  readonly retryable: boolean;
}> {}

export type EmailDeliveryPortService = {
  readonly send: (input: {
    readonly purpose: EmailProofPurpose;
    readonly to: EmailAddress;
    readonly combinedCode: EmailVerificationCode;
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
const decodeJson = Schema.decodeUnknownResult(UnknownJsonString);

const decodeBoundedResendResponse = Effect.fn(function* (response: BoundedExternalHttpResponse) {
  const successful =
    response.status >= successfulStatusMinimum &&
    response.status < successfulStatusMaximumExclusive;
  const json = decodeJson(new TextDecoder().decode(response.body));
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
const encodeResendRequest = Schema.encodeSync(jsonStringSchema(ResendRequest));

const classifyResendResponse = (
  response: BoundedExternalHttpResponse
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

const mapResendRequestFailure = (
  failure: ExternalHttpFailure | { readonly _tag: "TimeoutError" }
): EmailSendFailed => {
  const certainty =
    failure._tag === "ExternalHttpFailure"
      ? Option.match(failure.responseStatus, {
          onNone: () => "ambiguous" as const,
          onSome: (status) =>
            status >= successfulStatusMinimum && status < successfulStatusMaximumExclusive
              ? ("ambiguous" as const)
              : ("rejected" as const),
        })
      : "ambiguous";
  return new EmailSendFailed({ certainty, retryable: false });
};

export class EmailDeliveryPort extends Context.Service<
  EmailDeliveryPort,
  EmailDeliveryPortService
>()("@fidy/server/shell/email-authentication/delivery/EmailDeliveryPort") {
  static readonly layer = Layer.effect(
    EmailDeliveryPort,
    Effect.gen(function* () {
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        makeBoundedExternalHttpClient("resend")
      );
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
          const projection = verificationEmailFor(input.purpose, input.combinedCode);
          const request = HttpClientRequest.post("https://api.resend.com/emails", {
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
          });
          return httpClient
            .execute(request, maximumResendResponseBytes)
            .pipe(
              Effect.timeout("14 seconds"),
              Effect.mapError(mapResendRequestFailure),
              Effect.flatMap(classifyResendResponse)
            );
        },
      });
    })
  );
}
