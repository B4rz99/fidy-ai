import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { EmailAddress, EmailVerificationCode } from "~/core/email-authentication/contract";
import { OutboundHttpFailure } from "~/shell/outbound-http/contract";
import { jsonStringSchema } from "~/shell/schema-codecs/contract";
import { type EmailDeliveryPortService, EmailSendFailed } from "./contract";
import { makeEmailDelivery } from "./runtime";

const deliveryInput = (): Parameters<EmailDeliveryPortService["send"]>[0] => ({
  purpose: "verified-onboarding" as const,
  to: EmailAddress.make("person@example.com"),
  combinedCode: EmailVerificationCode.make("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ"),
  idempotencyKey: "private-delivery-idempotency",
});

const sendResponse = (
  response: Readonly<{ status: number; body: string }>
): Effect.Effect<Exit.Exit<void, EmailSendFailed>> =>
  makeEmailDelivery({
    outboundHttp: {
      execute: () =>
        Effect.succeed({
          status: response.status,
          headers: {},
          body: new TextEncoder().encode(response.body),
        }),
    },
  })
    .send(deliveryInput())
    .pipe(Effect.exit);

const assertFailure = (
  input: Readonly<{ exit: Exit.Exit<void, EmailSendFailed>; expected: EmailSendFailed }>
): void => {
  const unannotatedExit = Exit.isFailure(input.exit)
    ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(input.exit.cause)))
    : input.exit;
  assert.deepStrictEqual(unannotatedExit, Exit.fail(input.expected));
};

it.effect("maps Resend redirect responses to closed definitive failures", () =>
  Effect.gen(function* () {
    for (const status of [302, 307, 308]) {
      const exit = yield* sendResponse({ status, body: "private redirect body" });
      assertFailure({
        exit,
        expected: new EmailSendFailed({ certainty: "rejected", retryable: false }),
      });
      expect(String(exit)).not.toContain("private redirect body");
    }
  })
);

it.effect("accepts only a bounded provider message identity after a successful status", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* sendResponse({ status: 202, body: '{"id":"accepted-message"}' }),
      Exit.void
    );
    for (const body of [
      '{"id":""}',
      '{"id":12}',
      `{"id":"${"x".repeat(129)}"}`,
      "private bad JSON",
    ]) {
      const exit = yield* sendResponse({ status: 200, body });
      assertFailure({
        exit,
        expected: new EmailSendFailed({ certainty: "ambiguous", retryable: false }),
      });
      expect(String(exit)).not.toContain(body);
    }
  })
);

it.effect(
  "permits retry only for a decoded rate-limit rejection and contains provider ambiguity",
  () =>
    Effect.gen(function* () {
      for (const response of [
        {
          status: 429,
          body: '{"message":"provider detail"}',
          certainty: "rejected",
          retryable: true,
        },
        {
          status: 400,
          body: '{"message":"provider detail"}',
          certainty: "rejected",
          retryable: false,
        },
        { status: 429, body: "malformed provider body", certainty: "rejected", retryable: false },
        {
          status: 500,
          body: '{"id":"accepted-before-failure"}',
          certainty: "ambiguous",
          retryable: false,
        },
      ] as const) {
        const exit = yield* sendResponse(response);
        assertFailure({
          exit,
          expected: new EmailSendFailed({
            certainty: response.certainty,
            retryable: response.retryable,
          }),
        });
        expect(String(exit)).not.toContain(response.body);
      }
    })
);

it.effect("contains outbound failures without replaying uncertain delivery", () =>
  Effect.gen(function* () {
    for (const responseStatus of [
      Option.none(),
      Option.some(200),
      Option.some(503),
      Option.some(400),
    ]) {
      let attempts = 0;
      const delivery = makeEmailDelivery({
        outboundHttp: {
          execute: () => {
            attempts += 1;
            return Effect.fail(
              new OutboundHttpFailure({
                reason: "response-body-failed",
                responseStatus,
                responseHeaders: { "x-provider-detail": "private provider detail" },
              })
            );
          },
        },
      });
      const exit = yield* delivery.send(deliveryInput()).pipe(Effect.exit);
      assertFailure({
        exit,
        expected: new EmailSendFailed({
          certainty: Option.contains(responseStatus, 400) ? "rejected" : "ambiguous",
          retryable: false,
        }),
      });
      expect(attempts).toBe(1);
      expect(String(exit)).not.toContain("private provider detail");
    }
  })
);

const ProviderEmail = jsonStringSchema(
  Schema.Struct({
    from: Schema.String,
    to: Schema.Array(Schema.String),
    subject: Schema.String,
    text: Schema.String,
    html: Schema.String,
  })
);

it.effect(
  "delivers each bounded proof purpose with its fixed destination and idempotency identity",
  () =>
    Effect.gen(function* () {
      const purposes = [
        {
          purpose: "verified-onboarding",
          subject: "Verifica tu correo en Fidy",
          path: "/auth/verify-email",
        },
        {
          purpose: "credential-replacement",
          subject: "Verifica tu nuevo correo en Fidy",
          path: "/settings/email",
        },
        {
          purpose: "browser-pairing-approval",
          subject: "Tu código para iniciar sesión en Fidy",
          path: "/auth/pair",
        },
      ] as const;
      for (const expected of purposes) {
        const delivery = makeEmailDelivery({
          outboundHttp: {
            execute: (request) =>
              Effect.gen(function* () {
                expect(request._tag).toBe("ResendEmailDelivery");
                if (request._tag !== "ResendEmailDelivery") {
                  throw new Error("Unexpected provider operation");
                }
                expect(request.idempotencyKey).toBe("private-delivery-idempotency");
                const email = yield* Schema.decodeEffect(ProviderEmail, {
                  onExcessProperty: "error",
                })(request.body).pipe(Effect.orDie);
                expect(email.from).toBe("Fidy <obarboza@fidyapp.com>");
                expect(email.to).toEqual(["person@example.com"]);
                expect(email.subject).toBe(expected.subject);
                for (const body of [email.text, email.html]) {
                  expect(body).toContain("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ");
                  expect(body).toContain(`https://fidyapp.com${expected.path}`);
                  expect(body).toContain(
                    "Fidy nunca te pedirá este código por WhatsApp ni por soporte."
                  );
                  expect(body).not.toContain("person@example.com");
                  expect(body).not.toContain("private-delivery-idempotency");
                }
                return {
                  status: 200,
                  headers: {},
                  body: new TextEncoder().encode('{"id":"accepted-message"}'),
                };
              }),
          },
        });
        yield* delivery.send({ ...deliveryInput(), purpose: expected.purpose });
      }
    })
);

it.effect("interrupts stalled delivery at its fixed deadline without declaring rejection", () =>
  Effect.gen(function* () {
    let interrupted = false;
    const delivery = makeEmailDelivery({
      outboundHttp: {
        execute: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              })
            )
          ),
      },
    });
    const sending = yield* delivery
      .send(deliveryInput())
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("14 seconds");
    assertFailure({
      exit: yield* Fiber.join(sending),
      expected: new EmailSendFailed({ certainty: "ambiguous", retryable: false }),
    });
    expect(interrupted).toBe(true);
  })
);
