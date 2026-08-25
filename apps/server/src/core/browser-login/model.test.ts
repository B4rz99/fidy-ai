import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { BrowserLoginPrivateVerifier } from "./model";

const decodePrivateVerifier = Schema.decodeUnknownResult(BrowserLoginPrivateVerifier);
const validPrivateVerifier = "A".repeat(43);

it("accepts exactly 43 base64url characters as a private verifier", () => {
  expect(Result.isSuccess(decodePrivateVerifier(validPrivateVerifier))).toBe(true);
});

it("rejects a private verifier with an invalid leading character", () => {
  expect(Result.isFailure(decodePrivateVerifier(`!${validPrivateVerifier}`))).toBe(true);
});

it("rejects a private verifier with an invalid trailing character", () => {
  expect(Result.isFailure(decodePrivateVerifier(`${validPrivateVerifier}!`))).toBe(true);
});

it("rejects a private verifier containing a character outside the base64url alphabet", () => {
  const invalidCharacter = `${validPrivateVerifier.slice(0, 21)}!${validPrivateVerifier.slice(22)}`;

  expect(Result.isFailure(decodePrivateVerifier(invalidCharacter))).toBe(true);
});

it("rejects private verifiers shorter or longer than 43 characters", () => {
  expect(Result.isFailure(decodePrivateVerifier(validPrivateVerifier.slice(0, 42)))).toBe(true);
  expect(Result.isFailure(decodePrivateVerifier(`${validPrivateVerifier}A`))).toBe(true);
});
