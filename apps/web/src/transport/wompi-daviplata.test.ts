import { it as effectIt } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it, vi } from "vitest";
import { startDaviplataWithWompi } from "./wompi-daviplata";

// Synthetic protocol fixtures, not recorded provider responses or live Sandbox/CORS proof.
const approvedUrl = "https://sandbox.wompi.co/synthetic/send";
const mountedSignal = (): AbortSignal => new AbortController().signal;

afterEach(() => vi.restoreAllMocks());

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
const otpResponse = (status: "PENDING" | "APPROVED", bearer: string, pk = tokenId): Response =>
  Response.json({
    data: {
      subscription: { PK: pk, status },
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
      for (const call of provider.mock.calls) {
        expect(call[1]).toMatchObject({
          method: "POST",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
      }
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
  ["SEND", "PENDING"],
  ["SEND", "APPROVED"],
  ["CONFIRM", "PENDING"],
  ["CONFIRM", "APPROVED"],
] as const)(
  "revokes authority on %s when a %s response substitutes another same-environment PK",
  (stage, status) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const foreignBearer = "synthetic-foreign-bearer";
        const foreignPk = "daviplata_devtest_other_synthetic";
        const provider = vi
          .fn((_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
            Promise.resolve(otpResponse("APPROVED", "synthetic-later-approval"))
          )
          .mockResolvedValueOnce(initialResponse());
        if (stage === "CONFIRM") {
          provider.mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
        }
        provider.mockResolvedValueOnce(otpResponse(status, foreignBearer, foreignPk));
        const started = yield* Effect.exit(start(provider));
        if (stage === "SEND") {
          // No challenge/approval capability is returned from a refused initial send.
          expect(Exit.isFailure(started)).toBe(true);
        } else {
          if (!Exit.isSuccess(started)) {
            throw new Error("Expected the legitimate initial send to succeed");
          }
          const challenge = started.value;
          const otp = Redacted.make("574829");
          expect(yield* challenge.confirm(otp)).toEqual({ status: "uncertain" });
          expect(() => Redacted.value(otp)).toThrow();
          const subsequentOtp = Redacted.make("111111");
          expect(yield* challenge.confirm(subsequentOtp)).toEqual({ status: "refused" });
          expect(yield* challenge.resend()).toEqual({ status: "refused" });
          expect(yield* challenge.retrySubmission()).toEqual({ status: "refused" });
          expect(() => Redacted.value(subsequentOtp)).toThrow();
        }
        yield* Effect.yieldNow;
        expect(provider).toHaveBeenCalledTimes(stage === "SEND" ? 2 : 3);
        for (const [, init] of provider.mock.calls) expect(init?.signal?.aborted).toBe(true);
        expect(provider.mock.calls.map(([, init]) => init?.headers)).not.toContainEqual(
          expect.objectContaining({ authorization: `Bearer ${foreignBearer}` })
        );
        // This transport owns no Fidy submission function: no approved outcome may leave this seam.
      })
    )
);

it("fingerprints one-use authority with SHA-256, clears borrowed digest buffers, and exposes only redacted approval", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
      const provider = vi
        .fn((_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
          Promise.resolve(otpResponse("APPROVED", "synthetic-terminal-bearer"))
        )
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
      const challenge = yield* start(provider);
      const approval = yield* challenge.confirm(Redacted.make("574829"));
      expect(digest).toHaveBeenCalledTimes(3);
      for (const [algorithm, bytes] of digest.mock.calls) {
        expect(algorithm).toBe("SHA-256");
        expect(ArrayBuffer.isView(bytes)).toBe(true);
        if (ArrayBuffer.isView(bytes)) {
          expect(
            new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).every(
              (byte) => byte === 0
            )
          ).toBe(true);
        }
      }
      expect(Object.keys(approval).sort()).toEqual(["status", "token"]);
      if (approval.status !== "approved") throw new Error("Expected synthetic approval");
      expect(Redacted.isRedacted(approval.token)).toBe(true);
      expect(Redacted.value(approval.token)).toBe(tokenId);
      challenge.dispose();
      expect(() => Redacted.value(approval.token)).toThrow();
    })
  ));

it("cancels a pending digest on disposal without posting borrowed one-use authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi
        .fn(() => Promise.resolve(otpResponse("APPROVED", "synthetic-terminal-bearer")))
        .mockResolvedValueOnce(initialResponse())
        .mockResolvedValueOnce(otpResponse("PENDING", "synthetic-send-bearer"));
      const challenge = yield* start(provider);
      const pending = Promise.withResolvers<ArrayBuffer>();
      const hashing = Promise.withResolvers<void>();
      vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(() => {
        hashing.resolve();
        return pending.promise;
      });
      const otp = Redacted.make("574829");
      const fiber = yield* Effect.forkChild(challenge.confirm(otp), { startImmediately: true });
      yield* Effect.tryPromise(() => hashing.promise);
      challenge.dispose();
      expect((yield* Fiber.join(fiber)).status).toBe("uncertain");
      expect(() => Redacted.value(otp)).toThrow();
      pending.resolve(new ArrayBuffer(32));
      yield* Effect.tryPromise(() => pending.promise);
      expect(provider).toHaveBeenCalledTimes(2);
    })
  ));

it("fails closed before OTP POST if SHA-256 fingerprinting is unavailable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(
        new Error("Synthetic crypto failure")
      );
      const provider = vi.fn(() => Promise.resolve(initialResponse()));
      const result = yield* Effect.exit(start(provider));
      expect(Exit.isFailure(result)).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1);
    })
  ));

it.each([
  "https://other.invalid/send",
  `${policy.sendUrl}?synthetic=1`,
  `http://sandbox.wompi.co/synthetic/send`,
])("rejects an invalid prepared OTP policy before tokenization: %s", (sendUrl) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi.fn(() => Promise.resolve(initialResponse()));
      const documentNumber = Redacted.make("1122233");
      const productNumber = Redacted.make("3991111111");
      const result = yield* Effect.exit(
        startDaviplataWithWompi({
          publicKey: "pub_test_synthetic",
          policy: { ...policy, sendUrl },
          fields: { documentNumber, productNumber },
          fetchImplementation: provider,
          signal: mountedSignal(),
          expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
        })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(provider).not.toHaveBeenCalled();
      expect(() => Redacted.value(documentNumber)).toThrow();
      expect(() => Redacted.value(productNumber)).toThrow();
    })
  )
);

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
