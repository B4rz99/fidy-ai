import assert from "node:assert/strict";
import { Effect, Exit, Option, Redacted } from "effect";
import { expect, it } from "vitest";
import {
  type OutboundHttpService,
  makeWompiOutboundHttp,
} from "../../src/shell/outbound-http/operations";
import {
  makeTestOutboundTransport,
  testOutboundTransportResponse,
} from "../../src/shell/outbound-http/testing";
import { workerCrypto } from "./internal/wompi-runtime";
import {
  DaviplataSandboxProofFailure,
  authorizeDaviplataSandbox,
  requireDaviplataSandboxPolicy,
} from "./daviplata-sandbox.test-fixture";

// Synthetic transport premises, not recorded Sandbox responses or approved endpoint configuration.
const policy = {
  sendUrl: "https://sandbox.wompi.co/synthetic-test/send",
  confirmUrl: "https://sandbox.wompi.co/synthetic-test/confirm",
};
const outboundFor = (
  handler: Parameters<typeof makeTestOutboundTransport>[0]
): OutboundHttpService =>
  makeWompiOutboundHttp({
    environment: "sandbox",
    publicKey: "pub_test_synthetic_only",
    privateKey: Redacted.make("synthetic-private"),
    integritySecret: Redacted.make("synthetic-integrity"),
    crypto: workerCrypto,
    daviplataSandboxPolicy: Option.some(policy),
    httpClient: makeTestOutboundTransport(handler),
  });

type ProtocolPremise = Readonly<{
  name: string;
  sendUrl: string;
  confirmUrl: string;
  wrongIdentityAt: number;
  malformedAt: number;
  stopAt: number;
}>;
const ordinary: ProtocolPremise = {
  name: "ordinary",
  ...policy,
  wrongIdentityAt: 0,
  malformedAt: 0,
  stopAt: 3,
};
const syntheticBody = (step: number, premise: ProtocolPremise): string => {
  if (step === premise.malformedAt) return "not-json";
  if (step === 1) {
    return JSON.stringify({
      data: {
        id: "synthetic-authorization",
        status: "PENDING",
        url_services: {
          token: "synthetic-send-bearer",
          code_otp_send: premise.sendUrl,
          code_otp_validate: premise.confirmUrl,
        },
      },
    });
  }
  return JSON.stringify({
    data: {
      subscription: {
        PK:
          step === premise.wrongIdentityAt
            ? "synthetic-foreign-authorization"
            : "synthetic-authorization",
        status: step === 2 ? "PENDING" : "APPROVED",
      },
      authorization: { access_token: "synthetic-confirm-bearer" },
    },
  });
};

it.each([
  {
    environment: "production",
    sendUrl: Option.some(policy.sendUrl),
    confirmUrl: Option.some(policy.confirmUrl),
  },
  {
    environment: "sandbox",
    sendUrl: Option.none<string>(),
    confirmUrl: Option.some(policy.confirmUrl),
  },
  {
    environment: "sandbox",
    sendUrl: Option.some(policy.sendUrl),
    confirmUrl: Option.none<string>(),
  },
  {
    environment: "sandbox",
    sendUrl: Option.some("https://production.wompi.co/synthetic-test/send"),
    confirmUrl: Option.some(policy.confirmUrl),
  },
  {
    environment: "sandbox",
    sendUrl: Option.some(policy.sendUrl),
    confirmUrl: Option.some("https://sandbox.wompi.co.evil.example/confirm"),
  },
])("rejects unreviewed or missing Sandbox policy before provider work ($environment)", (input) =>
  Effect.runPromise(
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* Effect.exit(requireDaviplataSandboxPolicy(input)),
        Exit.fail(new DaviplataSandboxProofFailure())
      );
    })
  )
);

it.each([
  { ...ordinary, name: "send destination", sendUrl: `${policy.sendUrl}/unreviewed`, stopAt: 1 },
  {
    ...ordinary,
    name: "confirm destination",
    confirmUrl: `${policy.confirmUrl}/unreviewed`,
    stopAt: 1,
  },
  { ...ordinary, name: "send identity", wrongIdentityAt: 2, stopAt: 2 },
  { ...ordinary, name: "confirm identity", wrongIdentityAt: 3 },
  { ...ordinary, name: "malformed response", malformedAt: 1, stopAt: 1 },
])(
  "rejects $name substitution before releasing further authority and without replaying a POST",
  (premise) =>
    Effect.runPromise(
      Effect.gen(function* () {
        let requests = 0;
        const outbound = outboundFor((request) => {
          requests += 1;
          return Effect.succeed(
            testOutboundTransportResponse(request, new Response(syntheticBody(requests, premise)))
          );
        });
        assert.deepStrictEqual(
          yield* Effect.exit(authorizeDaviplataSandbox({ outbound, policy, outcome: "approved" })),
          Exit.fail(new DaviplataSandboxProofFailure())
        );
        expect(requests).toBe(premise.stopAt);
      })
    )
);

it("rotates the synthetic one-use service bearer and confirms the same reusable authorization once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let requests = 0;
      const authorization: Array<string> = [];
      const outbound = outboundFor((request) => {
        requests += 1;
        authorization.push(new Headers(request.headers).get("authorization") ?? "");
        return Effect.succeed(
          testOutboundTransportResponse(request, new Response(syntheticBody(requests, ordinary)))
        );
      });
      const token = yield* authorizeDaviplataSandbox({ outbound, policy, outcome: "declined" });
      expect(Redacted.value(token)).toBe("synthetic-authorization");
      expect(requests).toBe(3);
      expect(authorization).toEqual([
        "Bearer pub_test_synthetic_only",
        "Bearer synthetic-send-bearer",
        "Bearer synthetic-confirm-bearer",
      ]);
    })
  ));
