import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { createScriptVersion } from "@distilled.cloud/cloudflare/workers";
import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vitest";
import { resourceFailureMessage } from "./production-resources";

describe("resource release refusal diagnostics", () => {
  it("identifies a rejected Worker version configuration without publishing its provider message", () => {
    expect(
      resourceFailureMessage(
        Cause.fail({
          _tag: "WorkerVersionConfigError",
          message: "private Worker binding configuration",
        })
      )
    ).toBe("Alchemy resource operation failed (WorkerVersionConfigError); inspect release state.");
  });
  it("retains provider refusal codes without foreign messages or bodies", () => {
    const cause = Cause.fail({
      _tag: "Forbidden",
      code: 10000,
      message: "Bearer private-token",
      body: "private recovery proof",
    });
    expect(resourceFailureMessage(cause)).toBe(
      "Alchemy resource operation failed (Forbidden; code=10000); inspect release state."
    );
  });

  it("reports concurrent provider failures and defects using closed categories", () => {
    const cause = Cause.combine(
      Cause.fail({ _tag: "UnknownCloudflareError", code: 12130, message: "private" }),
      Cause.die({ _tag: "CloudflareParseError", body: "private" })
    );
    expect(resourceFailureMessage(cause)).toBe(
      "Alchemy resource operation failed (UnknownCloudflareError; code=12130, CloudflareParseError); inspect release state."
    );
  });

  it("never publishes unknown tags, messages, invalid codes or arbitrary defects", () => {
    for (const error of [
      { _tag: "private-token", code: 10000 },
      { _tag: "Forbidden", code: "private-token" },
      { _tag: "Forbidden", code: -1 },
      Error("private recovery proof"),
    ]) {
      const result = resourceFailureMessage(Cause.die(error));
      expect(result).not.toMatch(/private|code=-1/u);
      expect(result).toMatch(/^Alchemy resource operation failed/u);
    }
  });
});

it.effect.each([
  { code: 10021, expected: " (BadRequest; code=10021)" },
  { code: undefined, expected: " (BadRequest)" },
  { code: "private-code", expected: " (BadRequest)" },
  { code: -1, expected: "" },
])("retains only a native numeric upload refusal code: $code", ({ code, expected }) =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            { success: false, errors: [{ code, message: "private binding value" }] },
            { status: 400 }
          )
        )
      )
    );
    const result = yield* createScriptVersion({
      accountId: "test-account",
      scriptName: "test-worker",
      metadata: { mainModule: "index.js" },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed(apiTokenCredentials({ apiToken: "test-only" }))
      ),
      Effect.matchCause({
        onFailure: resourceFailureMessage,
        onSuccess: () => "unexpected success",
      })
    );
    expect(result).toBe(`Alchemy resource operation failed${expected}; inspect release state.`);
    expect(result).not.toContain("private");
  })
);
