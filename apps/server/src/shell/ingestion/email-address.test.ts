import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { forwardingLocalPartForDomain, normalizedMailbox } from "./email-address";

const ingestDomain = "ingest.fidyapp.com";

describe("forwarded email recipient normalization", () => {
  it("extracts and normalizes a mailbox from a display-name recipient", () => {
    expect(normalizedMailbox("Fidy Alerts <ABC_def@INGEST.FIDYAPP.COM>")).toBe(
      "abc_def@ingest.fidyapp.com"
    );
    expect(
      Option.getOrThrow(
        forwardingLocalPartForDomain(
          "Fidy Alerts <abcdefghijklmnopqrstuvwx@INGEST.FIDYAPP.COM>",
          ingestDomain
        )
      )
    ).toBe("abcdefghijklmnopqrstuvwx");
  });

  it("rejects malformed, domain-mismatched, and non-mailbox recipients", () => {
    expect(
      Option.isNone(
        forwardingLocalPartForDomain(
          "Alerts <abcdefghijklmnopqrstuvwx@ingest.fidyapp.com",
          ingestDomain
        )
      )
    ).toBe(true);
    expect(
      Option.isNone(
        forwardingLocalPartForDomain("abcdefghijklmnopqrstuvwx@example.com", ingestDomain)
      )
    ).toBe(true);
    expect(Option.isNone(forwardingLocalPartForDomain("not-a-mailbox", ingestDomain))).toBe(true);
  });
});
