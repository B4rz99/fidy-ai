import { registeredConnectionInstitutionIds } from "../../src/shell/connections/contract";
import { Effect, Schema } from "effect";
import { type CoreHttpEnvironment } from "./contract";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { coreHttpHandler } from "./runtime";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry/operations";

const burstLogs = (logs: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> =>
  logs.flatMap((call) => {
    const encoded = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(call);

    return encoded.includes("component=core-rejections") ? [encoded] : [];
  });

const environment: CoreHttpEnvironment = {
  RELEASE_GIT_SHA: "0".repeat(40),
  CONTRACT_DIGEST: "0".repeat(64),
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  KAPSO_API_KEY: "private-provider-key",
  KAPSO_WEBHOOK_SECRET: "private-webhook-secret",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "private-portfolio",
  CLOUDFLARE_ACCESS_ISSUER: "https://unused.example",
  CLOUDFLARE_ACCESS_AUDIENCE: "unused",
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_INTEGRITY_SECRET: "",
};

type CoreHandler = ReturnType<typeof coreHttpHandler>;

const refusedBody = Effect.fn(function* (core: CoreHandler, request: Request) {
  const response = yield* Effect.tryPromise(() => core(request, environment));
  expect(response.status).toBe(401);

  return yield* Effect.tryPromise(() => response.text());
});

const discardedReply = Effect.fn(function* (
  send: (path: string) => Promise<Response>,
  path: string,
  status: number
) {
  const response = yield* Effect.tryPromise(() => send(path));
  expect(response.status).toBe(status);
  yield* Effect.tryPromise(() => response.text());
});

it.live("preserves actual Core callback refusals and never stores attacker request content", () =>
  Effect.gen(function* () {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(Date, "now").mockReturnValue(1_800_000)),
      (clock) => Effect.sync(() => clock.mockRestore())
    );

    const core = coreHttpHandler({
      telemetry: cloudflareWorkerTelemetry,
      institutions: registeredConnectionInstitutionIds,
    });

    const request = (): Request =>
      new Request("https://api.fidyapp.com/providers/kapso/callback?secret=private-query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-event": "whatsapp.message.received",
          "x-webhook-signature": "private-invalid-signature",
          authorization: "Bearer private-token",
        },
        body: '{"secret":"private-user-content"}',
      });

    const bodies = yield* Effect.forEach(Array.from({ length: 101 }), () =>
      refusedBody(core, request())
    );

    expect(new Set(bodies).size).toBe(1);

    const warnings = burstLogs(logs.mock.calls);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("severity=warning");
    expect(warnings[0]).not.toContain("private-");
  })
);

it.live(
  "counts malformed provider callbacks without accepting forged boundary labels or path prefixes",
  () =>
    Effect.gen(function* () {
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(Date, "now").mockReturnValue(1_800_000)),
        (clock) => Effect.sync(() => clock.mockRestore())
      );

      const core = coreHttpHandler({
        telemetry: cloudflareWorkerTelemetry,
        institutions: registeredConnectionInstitutionIds,
      });

      const send = (path: string): Promise<Response> =>
        core(
          new Request(`https://api.fidyapp.com${path}?private=callback`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-security-boundary": "mcp",
              "x-webhook-event": "private-unknown-event",
              "x-mcp-name": "private-forged-tool",
            },
            body: '{"boundary":"providerCallback","secret":"private-user-content"}',
          }),
          environment
        );

      yield* Effect.forEach(
        Array.from({ length: 100 }),
        () => discardedReply(send, "/providers/kapso/callback-extra", 404),
        { discard: true }
      );

      expect(burstLogs(logs.mock.calls)).toEqual([]);

      yield* Effect.forEach(
        Array.from({ length: 100 }),
        () => discardedReply(send, "/providers/kapso/callback", 422),
        { discard: true }
      );

      const warnings = burstLogs(logs.mock.calls);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain("private-");
    })
);
