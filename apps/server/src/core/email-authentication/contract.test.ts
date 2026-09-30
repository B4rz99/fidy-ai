import { expect, it } from "@effect/vitest";

import { Option, Schema } from "effect";

import { EmailAddress } from "./contract";

it("rejects oversized mailbox input before normalization while preserving plus and dot addresses", () => {
  expect(Option.isNone(Schema.decodeOption(EmailAddress)(`${" ".repeat(513)}a@example.com`))).toBe(
    true
  );
  expect(Schema.decodeSync(EmailAddress)("  A.B+tag@Example.COM  ")).toBe("a.b+tag@example.com");
});
