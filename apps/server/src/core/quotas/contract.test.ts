import { Result, Schema } from "effect";
import { expect, it } from "vitest";
import { CanonicalRetryKey } from "./contract";

it("accepts bounded opaque retry references without whitespace or interpreter punctuation", () => {
  const decode = Schema.decodeUnknownResult(CanonicalRetryKey);
  for (const value of ["a", "Z", "0", "_", "-", "retry_ABC-019", "a".repeat(128)]) {
    expect(Result.isSuccess(decode(value)), value).toBe(true);
  }
  for (const value of [
    "",
    "a".repeat(129),
    "a b",
    "a\nb",
    " a",
    "a ",
    "a/b",
    "a.b",
    "a+b",
    "á",
    "a:b",
    "a@b",
    "[key]",
    "a\u0000",
  ]) {
    expect(Result.isFailure(decode(value)), value).toBe(true);
  }
});
