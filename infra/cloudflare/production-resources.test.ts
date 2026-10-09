import { Cause } from "effect";
import { describe, expect, it } from "vitest";
import { resourceFailureMessage } from "./production-resources";

describe("resource release refusal diagnostics", () => {
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
