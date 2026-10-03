import { it as effectIt } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Option, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, it, vi } from "vitest";
import { postDaviplataOtp, startDaviplataWithWompi } from "./wompi-daviplata";

// Synthetic protocol fixtures, not recorded provider responses or live Sandbox/CORS proof.
const approvedUrl = "https://sandbox.wompi.co/synthetic/send";
const responseSchema = Schema.Struct({ accepted: Schema.Boolean });
const mountedSignal = (): AbortSignal => new AbortController().signal;

it("sends OTP material only to the exact approved endpoint without browser credentials or redirects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const authorization = Redacted.make("synthetic-authorization");
      const body = Redacted.make('{"synthetic":"payload"}');
      const provider = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(Response.json({ accepted: true }))
      );
      const result = yield* postDaviplataOtp({
        approvedUrl,
        publicKey: "pub_test_synthetic",
        providerUrl: approvedUrl,
        authorization,
        body: Option.some(body),
        signal: mountedSignal(),
        responseSchema,
        fetchImplementation: provider,
      });
      expect(result).toEqual({ accepted: true });
      expect(provider.mock.calls[0]?.[0]).toBe(approvedUrl);
      expect(provider.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(provider.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(() => Redacted.value(authorization)).toThrow();
      expect(() => Redacted.value(body)).toThrow();
    })
  ));

const policy = { sendUrl: approvedUrl, confirmUrl: "https://sandbox.wompi.co/synthetic/confirm" };
const tokenId = "daviplata_devtest_synthetic";
const initialResponse = (sendUrl = policy.sendUrl): Response =>
  Response.json({
    data: {
      id: tokenId,
      status: "PENDING",
      url_services: {
        token: "synthetic-initial-bearer",
        code_otp_send: sendUrl,
        code_otp_validate: policy.confirmUrl,
      },
    },
  });
const otpResponse = (status: "PENDING" | "APPROVED", bearer: string): Response =>
  Response.json({
    data: {
      subscription: { PK: tokenId, status },
      authorization: { access_token: bearer },
      attempts: {
        currentSendCode: 1,
        limitSendCode: 2,
        currentValidateCode: 0,
        limitValidateCode: 2,
      },
    },
  });

it("rotates one-use OTP authority and keeps approved authorization inside the provider challenge", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi
        .fn((_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
          Promise.resolve(initialResponse())
        )
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"))
        .mockResolvedValueOnce(otpResponse("APPROVED", "synthetic-confirm-bearer"));
      const documentNumber = Redacted.make("1122233");
      const productNumber = Redacted.make("3991111111");
      const challenge = yield* startDaviplataWithWompi({
        publicKey: "pub_test_synthetic",
        policy,
        fields: { documentNumber, productNumber },
        fetchImplementation: provider,
        signal: mountedSignal(),
        expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
      });
      const otp = Redacted.make("574829");
      const result = yield* challenge.confirm(otp);
      expect(result.status).toBe("approved");
      expect(provider.mock.calls.map((call) => call[0])).toEqual([
        "https://sandbox.wompi.co/v1/tokens/daviplata",
        policy.sendUrl,
        policy.confirmUrl,
      ]);
      expect(provider.mock.calls[1]?.[1]?.body).toBeUndefined();
      expect(provider.mock.calls[2]?.[1]?.headers).toEqual({
        authorization: "Bearer synthetic-send-bearer",
        "content-type": "application/json",
      });
      expect(() => Redacted.value(documentNumber)).toThrow();
      expect(() => Redacted.value(productNumber)).toThrow();
      expect(() => Redacted.value(otp)).toThrow();
      challenge.dispose();
    })
  ));

const start = (
  provider: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  signal = new AbortController().signal
): ReturnType<typeof startDaviplataWithWompi> =>
  Effect.gen(function* () {
    return yield* startDaviplataWithWompi({
      publicKey: "pub_test_synthetic",
      policy,
      fields: {
        documentNumber: Redacted.make("1122233"),
        productNumber: Redacted.make("3991111111"),
      },
      fetchImplementation: provider,
      signal,
      expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
    });
  });

it("separates approved-submission recovery from OTP actions and refuses recovery after disposal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi
        .fn((_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
          Promise.resolve(otpResponse("APPROVED", "synthetic-approval-bearer"))
        )
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
      const challenge = yield* start(provider);
      expect((yield* challenge.retrySubmission()).status).toBe("refused");
      const approval = yield* challenge.confirm(Redacted.make("574829"));
      expect(approval.status).toBe("approved");
      const recovery = yield* challenge.retrySubmission();
      expect(recovery.status).toBe("approved");
      const extraOtp = Redacted.make("574829");
      expect((yield* challenge.confirm(extraOtp)).status).toBe("refused");
      expect((yield* challenge.resend()).status).toBe("refused");
      expect(() => Redacted.value(extraOtp)).toThrow();
      expect(provider).toHaveBeenCalledTimes(3);
      challenge.dispose();
      expect((yield* challenge.retrySubmission()).status).toBe("refused");
      if (approval.status === "approved") expect(() => Redacted.value(approval.token)).toThrow();
    })
  ));

it("does not accept authorization approval from an OTP-send response", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi
        .fn((_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
          Promise.resolve(otpResponse("APPROVED", "synthetic-unexpected-approval"))
        )
        .mockResolvedValueOnce(initialResponse());
      const failed = yield* Effect.exit(start(provider));
      expect(Exit.isFailure(failed)).toBe(true);
      expect(provider).toHaveBeenCalledTimes(2);
    })
  ));

it.each([
  "https://other.invalid/send",
  `${policy.sendUrl}/extra`,
  `${policy.sendUrl}?secret=synthetic`,
])("rejects a provider destination mismatch before OTP egress", (sendUrl) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi.fn(() => Promise.resolve(initialResponse(sendUrl)));
      const result = yield* Effect.exit(start(provider));
      expect(Exit.isFailure(result)).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1);
    })
  )
);

it("serializes competing OTP actions without consuming the next one-use bearer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      const provider = vi
        .fn((_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
          started.resolve();
          return pending.promise;
        })
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
      const challenge = yield* start(provider);
      const first = yield* Effect.forkChild(challenge.confirm(Redacted.make("574829")), {
        startImmediately: true,
      });
      yield* Effect.tryPromise(() => started.promise);
      expect((yield* challenge.resend()).status).toBe("retry-allowed");
      expect((yield* challenge.confirm(Redacted.make("574829"))).status).toBe("retry-allowed");
      expect(provider).toHaveBeenCalledTimes(3);
      pending.resolve(otpResponse("PENDING", "synthetic-rotated-bearer"));
      yield* Fiber.join(first);
      challenge.dispose();
    })
  ));

it("permits an explicit incorrect-code retry with rotated authority but caps sends and validation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let rotation = 0;
      const provider = vi
        .fn((_url: RequestInfo | URL, _init?: RequestInit) =>
          Promise.resolve(otpResponse("PENDING", `synthetic-rotation-${++rotation}`))
        )
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
      const challenge = yield* start(provider);
      expect((yield* challenge.resend()).status).toBe("retry-allowed");
      expect((yield* challenge.resend()).status).toBe("refused");
      expect((yield* challenge.confirm(Redacted.make("111111"))).status).toBe("retry-allowed");
      expect((yield* challenge.confirm(Redacted.make("222222"))).status).toBe("retry-allowed");
      expect((yield* challenge.confirm(Redacted.make("333333"))).status).toBe("refused");
      expect(provider).toHaveBeenCalledTimes(5);
      expect(provider.mock.calls[3]?.[1]?.headers).toEqual({
        authorization: "Bearer synthetic-rotation-1",
        "content-type": "application/json",
      });
      challenge.dispose();
    })
  ));

it("stops permanently after ambiguous validation without automatically retrying an OTP", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi
        .fn((): Promise<Response> => Promise.reject(new Error("synthetic-hostile-error")))
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
      const challenge = yield* start(provider);
      const result = yield* challenge.confirm(Redacted.make("111111"));
      expect(result).toEqual({ status: "uncertain" });
      expect((yield* challenge.confirm(Redacted.make("222222"))).status).toBe("refused");
      expect((yield* challenge.resend()).status).toBe("refused");
      expect(provider).toHaveBeenCalledTimes(3);
    })
  ));

it("cancels a pending reader and wipes authority when the mounted challenge is disposed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reading = Promise.withResolvers<void>();
      let cancelled = false;
      const provider = vi
        .fn((_url: RequestInfo | URL, _init?: RequestInit) =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull: (): void => {
                  reading.resolve();
                },
                cancel: (): void => {
                  cancelled = true;
                },
              })
            )
          )
        )
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
      const challenge = yield* start(provider);
      const otp = Redacted.make("111111");
      const fiber = yield* Effect.forkChild(challenge.confirm(otp), { startImmediately: true });
      yield* Effect.tryPromise(() => reading.promise);
      challenge.dispose();
      expect((yield* Fiber.join(fiber)).status).toBe("uncertain");
      expect(cancelled).toBe(true);
      expect(() => Redacted.value(otp)).toThrow();
      expect((yield* challenge.resend()).status).toBe("refused");
    })
  ));

effectIt.effect("expires authorization absolutely even while the provider body is pending", () =>
  Effect.gen(function* () {
    const reading = Promise.withResolvers<void>();
    let cancelled = false;
    const provider = vi
      .fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull: (): void => {
                reading.resolve();
              },
              cancel: (): void => {
                cancelled = true;
              },
            })
          )
        )
      )
      .mockResolvedValueOnce(initialResponse())
      .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
    const challenge = yield* start(provider);
    const fiber = yield* Effect.forkChild(challenge.confirm(Redacted.make("111111")), {
      startImmediately: true,
    });
    yield* Effect.tryPromise(() => reading.promise);
    yield* TestClock.adjust("61 seconds");
    expect((yield* Fiber.join(fiber)).status).toBe("uncertain");
    expect(cancelled).toBe(true);
    expect((yield* challenge.resend()).status).toBe("refused");
  })
);

it("rejects dishonest streamed response sizes before parsing and cancels the body", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let cancelled = false;
      const provider = vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller): void => {
                controller.enqueue(new Uint8Array(16_385));
              },
              cancel: (): void => {
                cancelled = true;
              },
            }),
            { headers: { "content-length": "1" } }
          )
        )
      );
      const result = yield* Effect.exit(start(provider));
      expect(Exit.isFailure(result)).toBe(true);
      expect(cancelled).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1);
    })
  ));

it("refuses reused OTP bearers rather than sending a one-use credential twice", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi
        .fn(() => Promise.resolve(otpResponse("PENDING", "synthetic-send-bearer")))
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
      const challenge = yield* start(provider);
      expect((yield* challenge.confirm(Redacted.make("111111"))).status).toBe("uncertain");
      expect((yield* challenge.confirm(Redacted.make("222222"))).status).toBe("refused");
      expect(provider).toHaveBeenCalledTimes(3);
    })
  ));
