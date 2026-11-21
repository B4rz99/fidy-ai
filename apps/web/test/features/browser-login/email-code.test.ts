import { Option } from "effect";
import { expect, it } from "vitest";
import { readEmailVerificationCode } from "@/features/browser-login/email-code";

it.each([
  ["BCDF-GHJK-LMNP-QRST-VWXZ-2345"],
  ["BCDFGHJKLMNPQRSTVWXZ2345"],
  [" bcdf ghjk-lmnp qrst vwxz 2345 "],
])("reads %j as a verified-email code in the grouped format", (input) => {
  expect(readEmailVerificationCode(input)).toStrictEqual(
    Option.some("BCDF-GHJK-LMNP-QRST-VWXZ-2345")
  );
});

it.each([
  ["INVALIDINVALIDINVALID123"],
  ["BCDF-GHJK-LMNP-QRST-VWXZ"],
  ["BCDFGHJKLMNPQRSTVWXZ23456"],
  ["BCDF-GHJK-LMNP-QRST-VWXZ-23!5"],
])("rejects %j as incomplete or using characters codes never contain", (input) => {
  expect(readEmailVerificationCode(input)).toStrictEqual(Option.none());
});
