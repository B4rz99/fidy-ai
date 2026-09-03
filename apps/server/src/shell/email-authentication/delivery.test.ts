import { expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Ref } from "effect";
import {
  EmailAddress,
  type EmailProofPurpose,
  EmailVerificationCode,
} from "~/core/email-authentication/model";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { HttpClientRequest } from "effect/unstable/http";
import {
  EmailDeliveryPort,
  EmailSendFailed,
  browserPairingVerificationEmail,
  verificationEmail,
} from "./delivery";
import { sendEmailWithBoundedRetry } from "./delivery-retry";

const combinedCode = EmailVerificationCode.make("ABCD-2345-F7KM-9Q2D-X4PT-6RWC");
const emailAddress = EmailAddress.make("persona@example.com");
const deliveryInput = {
  purpose: "verified-onboarding" as const,
  to: emailAddress,
  combinedCode,
  idempotencyKey: "delivery-retry-test",
};

it.live("exhausts bounded retries for definitively rejected provider failures", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const status = yield* sendEmailWithBoundedRetry(deliveryInput).pipe(
      Effect.provideService(
        EmailDeliveryPort,
        EmailDeliveryPort.of({
          send: () =>
            Ref.update(attempts, (count) => count + 1).pipe(
              Effect.andThen(new EmailSendFailed({ certainty: "rejected", retryable: true }))
            ),
        })
      )
    );
    expect(status).toBe("rejected");
    expect(yield* Ref.get(attempts)).toBe(3);
  })
);

it.effect("does not retry an ambiguous provider failure", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const status = yield* sendEmailWithBoundedRetry(deliveryInput).pipe(
      Effect.provideService(
        EmailDeliveryPort,
        EmailDeliveryPort.of({
          send: () =>
            Ref.update(attempts, (count) => count + 1).pipe(
              Effect.andThen(new EmailSendFailed({ certainty: "ambiguous", retryable: true }))
            ),
        })
      )
    );
    expect(status).toBe("uncertain");
    expect(yield* Ref.get(attempts)).toBe(1);
  })
);

it("renders the fixed Spanish plain-text and minimal-HTML verification email", () => {
  expect(verificationEmail(combinedCode)).toEqual({
    subject: "Verifica tu correo en Fidy",
    text: `Tu código de verificación es:\n\n${combinedCode}\n\nEscríbelo en https://fidyapp.com/auth/verify-email. Este código vence en 10 minutos.\n\nSi no solicitaste este correo, ignóralo.\n\nFidy nunca te pedirá este código por WhatsApp ni por soporte.`,
    html: `<p>Tu código de verificación es:</p><p><strong><code>${combinedCode}</code></strong></p><p>Escríbelo en <a href="https://fidyapp.com/auth/verify-email">https://fidyapp.com/auth/verify-email</a>. Este código vence en 10 minutos.</p><p>Si no solicitaste este correo, ignóralo.</p><p>Fidy nunca te pedirá este código por WhatsApp ni por soporte.</p>`,
  });
});

it("renders fixed browser-login copy with only the bounded combined code varying", () => {
  expect(browserPairingVerificationEmail(combinedCode)).toEqual({
    subject: "Tu código para iniciar sesión en Fidy",
    text: `Tu código para iniciar sesión en Fidy es:\n\n${combinedCode}\n\nEscríbelo en https://fidyapp.com/auth/pair. Este código vence cuando termine la vinculación actual del navegador, como máximo 10 minutos después de iniciarla.\n\nSi no solicitaste este correo, ignóralo.\n\nFidy nunca te pedirá este código por WhatsApp ni por soporte.`,
    html: `<p>Tu código para iniciar sesión en Fidy es:</p><p><strong><code>${combinedCode}</code></strong></p><p>Escríbelo en <a href="https://fidyapp.com/auth/pair">https://fidyapp.com/auth/pair</a>. Este código vence cuando termine la vinculación actual del navegador, como máximo 10 minutos después de iniciarla.</p><p>Si no solicitaste este correo, ignóralo.</p><p>Fidy nunca te pedirá este código por WhatsApp ni por soporte.</p>`,
  });
});

const configLayer = (nodeEnv: "development" | "production"): Layer.Layer<never> =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      NODE_ENV: nodeEnv,
      RESEND_API_KEY: "re_test_only_resend_key_324000000",
      RESEND_FROM_EMAIL: "obarboza@fidyapp.com",
      RESEND_FROM_NAME: "Fidy",
    })
  );

const senderLayer = (
  status: number,
  requests: Array<HttpClientRequest.HttpClientRequest>,
  responseBody: string = '{"id":"resend-message-324"}'
): Layer.Layer<EmailDeliveryPort> => {
  const client = HttpClient.make((request) => {
    requests.push(request);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(responseBody, {
          status,
          headers: { "content-type": "application/json" },
        })
      )
    );
  });
  return EmailDeliveryPort.layer.pipe(
    Layer.provide(
      Layer.merge(Layer.succeed(HttpClient.HttpClient, client), configLayer("production"))
    ),
    Layer.orDie
  );
};

const failedResponseBodyLayer = (status: number): Layer.Layer<EmailDeliveryPort> => {
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream({
            start: (controller): void => controller.error(new Error("provider body read failed")),
          }),
          { status }
        )
      )
    )
  );
  return EmailDeliveryPort.layer.pipe(
    Layer.provide(
      Layer.merge(Layer.succeed(HttpClient.HttpClient, client), configLayer("production"))
    ),
    Layer.orDie
  );
};

const sendPurpose = (
  purpose: EmailProofPurpose
): Effect.Effect<void, EmailSendFailed, EmailDeliveryPort> =>
  Effect.flatMap(EmailDeliveryPort, (sender) =>
    sender.send({
      purpose,
      to: emailAddress,
      combinedCode,
      idempotencyKey: "email-enrollment-generation-1",
    })
  );

const send = sendPurpose("verified-onboarding");

const sendWith = (
  layer: Layer.Layer<EmailDeliveryPort>,
  operation: Effect.Effect<void, EmailSendFailed, EmailDeliveryPort> = send
): Effect.Effect<void, EmailSendFailed> =>
  Effect.scoped(
    Effect.flatMap(Layer.build(layer), (context) => operation.pipe(Effect.provide(context)))
  );

it.effect("does not contact Resend outside production", () =>
  Effect.gen(function* () {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
      );
    });
    const layer = EmailDeliveryPort.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HttpClient.HttpClient, client), configLayer("development"))
      ),
      Layer.orDie
    );

    const exit = yield* Effect.exit(sendWith(layer));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
        _tag: "EmailSendFailed",
        certainty: "rejected",
        retryable: false,
      });
    }
    expect(requests).toEqual([]);
  })
);

it.effect("selects the replacement and browser-pairing provider projections", () =>
  Effect.gen(function* () {
    for (const purpose of ["credential-replacement", "browser-pairing-approval"] as const) {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      yield* sendWith(senderLayer(200, requests), sendPurpose(purpose));
      expect(requests).toHaveLength(1);
    }
  })
);

it.effect("keeps Resend credentials out of typed failures", () =>
  Effect.gen(function* () {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const exit = yield* Effect.exit(sendWith(senderLayer(400, requests)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(String(failure)).not.toContain("re_test_only_resend_key_324000000");
      expect(failure).not.toHaveProperty("apiKey");
    }
  })
);

it.effect("rejects malformed and oversized successful provider responses as ambiguous", () =>
  Effect.gen(function* () {
    for (const body of ["not-json", `{"id":"${"x".repeat(5_000)}"}`]) {
      const exit = yield* Effect.exit(sendWith(senderLayer(200, [], body)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "EmailSendFailed",
          certainty: "ambiguous",
          retryable: false,
        });
      }
    }
  })
);

it.effect("rejects malformed, oversized, and unreadable failed provider responses", () =>
  Effect.gen(function* () {
    for (const body of ["not-json", `{"error":"${"x".repeat(5_000)}"}`]) {
      const exit = yield* Effect.exit(sendWith(senderLayer(400, [], body)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "EmailSendFailed",
          certainty: "rejected",
          retryable: false,
        });
      }
    }
    for (const [status, certainty] of [
      [200, "ambiguous"],
      [400, "rejected"],
    ] as const) {
      const exit = yield* Effect.exit(sendWith(failedResponseBodyLayer(status)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "EmailSendFailed",
          certainty,
          retryable: false,
        });
      }
    }
  })
);

it.effect("treats a successful status with a valid but unexpected body as ambiguous", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(sendWith(senderLayer(200, [], "{}")));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
        _tag: "EmailSendFailed",
        certainty: "ambiguous",
        retryable: false,
      });
    }
  })
);

it.effect("fails closed on a malformed production Resend API key", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response('{"id":"unused"}', { status: 200 }))
      )
    );
    const malformedConfig = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        NODE_ENV: "production",
        RESEND_API_KEY: "not-a-resend-key",
        RESEND_FROM_EMAIL: "obarboza@fidyapp.com",
        RESEND_FROM_NAME: "Fidy",
      })
    );
    const exit = yield* Effect.exit(
      Effect.scoped(
        Layer.build(
          EmailDeliveryPort.layer.pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(HttpClient.HttpClient, client), malformedConfig)
            )
          )
        )
      )
    );
    expect(Exit.isFailure(exit)).toBe(true);
  })
);

it.effect.each([
  { status: 200, expected: "success" },
  { status: 299, expected: "success" },
  { status: 400, expected: "rejected" },
  { status: 429, expected: "retryable" },
  { status: 500, expected: "retryable" },
] as const)("classifies Resend status $status as $expected", ({ status, expected }) =>
  Effect.gen(function* () {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const exit = yield* Effect.exit(sendWith(senderLayer(status, requests)));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.resend.com/emails");
    expect(requests[0]?.headers.authorization).toBe("Bearer re_test_only_resend_key_324000000");
    expect(requests[0]?.headers["idempotency-key"]).toBe("email-enrollment-generation-1");
    if (expected === "success") {
      expect(Exit.isSuccess(exit)).toBe(true);
    } else if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
        _tag: "EmailSendFailed",
        certainty: "rejected",
        retryable: expected === "retryable",
      });
    } else {
      expect.fail("expected email delivery to fail");
    }
  })
);
