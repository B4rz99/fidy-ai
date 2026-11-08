import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { createScriptVersion } from "@distilled.cloud/cloudflare/workers";
import { BadRequest } from "@distilled.cloud/cloudflare/Errors";
import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vitest";
import { resourceFailureMessage } from "./production-resources";

describe("resource release refusal diagnostics", () => {
  it("retains a migration refusal and its provider cause after serialization", () => {
    const wrapped = new Error("private migration text", {
      cause: BadRequest.make({ message: "private provider refusal" }),
    });
    wrapped.name = "MigrationError";
    const restored = Schema.decodeSync(Schema.Defect())(
      Schema.encodeSync(Schema.Defect())(wrapped)
    );
    expect(resourceFailureMessage(Cause.fail(restored))).toBe(
      "Alchemy resource operation failed (MigrationError, BadRequest); inspect release state."
    );
  });
  it("bounds cause traversal and excludes private nested values", () => {
    const cyclic = new Error("private text");
    cyclic.cause = cyclic;
    expect(resourceFailureMessage(Cause.fail(cyclic))).toBe(
      "Alchemy resource operation failed (Error); inspect release state."
    );
    const nested = new Error("private text", {
      cause: new Error("private proof", { cause: { _tag: "Forbidden", code: 10000 } }),
    });
    expect(resourceFailureMessage(Cause.fail(nested))).toBe(
      "Alchemy resource operation failed (Error, Forbidden; code=10000); inspect release state."
    );
    const unknown = new Error("private text", {
      cause: { _tag: "private-token", message: "private" },
    });
    expect(resourceFailureMessage(Cause.fail(unknown))).toBe(
      "Alchemy resource operation failed (Error); inspect release state."
    );
  });

  it("retains a known provider category after error serialization drops its tag and code", () => {
    const error = BadRequest.make({ message: "Bearer private-token" });
    const serialized = Schema.encodeSync(Schema.Defect())(error);
    const restored = Schema.decodeSync(Schema.Defect())(serialized);
    expect(resourceFailureMessage(Cause.fail(restored))).toBe(
      "Alchemy resource operation failed (BadRequest); inspect release state."
    );
  });
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

  it("distinguishes native upload exceptions without publishing their messages", () => {
    for (const [error, category] of [
      [new TypeError("private request body"), "TypeError"],
      [new RangeError("private token"), "RangeError"],
      [new Error("private recovery proof"), "Error"],
      [new Cause.UnknownError({ token: "private" }), "UnknownError"],
    ] as const) {
      expect(resourceFailureMessage(Cause.die(error))).toBe(
        `Alchemy resource operation failed (${category}); inspect release state.`
      );
    }
  });

  it("excludes private stacks and unknown exception names", () => {
    const error = new Error("Bearer private-token");
    error.stack = [
      "Error: Bearer private-token",
      "    at upload (/private-user/fidy/node_modules/alchemy/src/Cloudflare/Workers/WorkerProvider.ts:4253:14)",
      "    at unknown (/private-user/private-proof.ts:99:1)",
    ].join("\n");
    expect(resourceFailureMessage(Cause.die(error))).toBe(
      "Alchemy resource operation failed (Error); inspect release state."
    );
    error.name = "private-token";
    error.stack = "Error: private\n    at private (/private-proof.ts:3:1)";
    expect(resourceFailureMessage(Cause.die(error))).toBe(
      "Alchemy resource operation failed (Error); inspect release state."
    );
  });
});

it.effect.each([
  { code: 10021, expected: " (BadRequest; code=10021)" },
  { code: undefined, expected: " (BadRequest)" },
  { code: "private-code", expected: " (BadRequest)" },
  { code: -1, expected: " (BadRequest)" },
  { code: 10007, expected: " (WorkerNotFound; code=10007)" },
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
