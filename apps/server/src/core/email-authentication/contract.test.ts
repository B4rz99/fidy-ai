import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { EmailAddress, EmailVerificationCode } from "./contract";

const decodeEmail = Schema.decodeUnknownResult(EmailAddress);

it("trims and lowercases a conservative mailbox without provider alias folding", () => {
  expect(decodeEmail("  Person.Name+Fidy@Example.COM  ")).toEqual(
    Result.succeed(EmailAddress.make("person.name+fidy@example.com"))
  );
  expect(decodeEmail("person.name@example.com")).not.toEqual(decodeEmail("personname@example.com"));
});

it("rejects mailbox forms outside the bounded launch grammar", () => {
  const rejected = [
    "a@localhost",
    ".a@example.com",
    "a.@example.com",
    "a..b@example.com",
    '"a b"@example.com',
    "a@[127.0.0.1]",
    `a@${"x".repeat(64)}.com`,
    `${"a".repeat(251)}@x.co`,
  ];
  for (const candidate of rejected) {
    expect(Result.isFailure(decodeEmail(candidate))).toBe(true);
  }
});

it("accepts only six unambiguous uppercase groups at the browser proof boundary", () => {
  const decodeCode = Schema.decodeUnknownResult(EmailVerificationCode);
  expect(decodeCode("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ")).toEqual(
    Result.succeed(EmailVerificationCode.make("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ"))
  );
  for (const input of [
    "abcd-EFGH-JKLM-NPQR-STUV-WXYZ",
    "ABCI-EFGH-JKLM-NPQR-STUV-WXYZ",
    "ABCD-EFGH-JKLM-NPQR-STUV-WXY0",
    "ABCD-EFGH-JKLM-NPQR-STUV",
    "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345",
    " ABCD-EFGH-JKLM-NPQR-STUV-WXYZ ",
  ]) {
    expect(Result.isFailure(decodeCode(input))).toBe(true);
  }
});

it("preserves allowed local-part punctuation and accepts one-character and maximum-length domain labels", () => {
  for (const address of [
    "a@b.c",
    "0@1.9",
    "z@z.z",
    "a.b.c@a-b.c-d",
    "a!#$%&'*+/=?^_`{|}~-z@example.com",
    `a@${"x".repeat(63)}.com`,
    `a@b.${"x".repeat(63)}`,
    `${"a".repeat(249)}@x.co`,
  ]) {
    expect(decodeEmail(address)).toEqual(Result.succeed(EmailAddress.make(address)));
  }
  for (const address of [
    "",
    "@b.c",
    "a@",
    "a@b",
    "a@b.",
    "a@.b",
    "a@-b.c",
    "a@b-.c",
    "a@b.-c",
    "a@b.c-",
    "a@b..c",
    "a@b_c.d",
    "a@b.c_d",
    "a@b/c.d",
    "a@b.c/d",
    "a@b@c.d",
    "a b@c.d",
    "a:b@c.d",
    "a,b@c.d",
    "a\\b@c.d",
    "a@b.c\nx",
    `a@b.${"x".repeat(64)}`,
    `${"a".repeat(250)}@x.co`,
  ]) {
    expect(Result.isFailure(decodeEmail(address)), address).toBe(true);
  }
});

it("encodes a canonical mailbox without losing the normalization established at decode", () => {
  const decoded = Schema.decodeSync(EmailAddress)(" Person.Name+Fidy@Example.COM ");
  expect(Schema.encodeSync(EmailAddress)(decoded)).toBe("person.name+fidy@example.com");
});
