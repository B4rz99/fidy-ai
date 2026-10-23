import { Result, Schema } from "effect";
import { expect, it } from "vitest";
import { BackupRecoveryCode } from "./contract";

it("accepts five groups of five unambiguous base32 symbols and rejects altered grouping or alphabet", () => {
  const decode = Schema.decodeUnknownResult(BackupRecoveryCode);
  const valid = "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2";
  expect(Result.isSuccess(decode(valid))).toBe(true);
  expect(Result.isSuccess(decode("23456-789AB-CDEFG-HJKLM-NPQRS"))).toBe(true);
  for (const value of [
    "",
    `x${valid}`,
    `${valid}x`,
    ` ${valid}`,
    `${valid} `,
    valid.toLowerCase(),
    "ABCD-FGHJK-LMNPQ-RSTUV-WXYZ2",
    "ABCDEF-FGHJK-LMNPQ-RSTUV-WXYZ2",
    "ABCDE-FGHJK-LMNPQ-RSTUV",
    `${valid}-ABCDE`,
    valid.replaceAll("-", ""),
    valid.replaceAll("-", "."),
    ...["I", "O", "0", "1", "!", "á", " ", "\n"].map((character) => valid.replace("M", character)),
  ]) {
    expect(Result.isFailure(decode(value)), value).toBe(true);
  }
});
