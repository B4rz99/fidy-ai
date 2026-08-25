import { expect, it } from "@effect/vitest";
import { normalizeOpaqueProof32 } from "./opaque-proof";

const validProof = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";

it("keeps an exact 43-character base64url proof unchanged", () => {
  expect(normalizeOpaqueProof32(validProof)).toBe(validProof);
});

it("pads a too-short proof to the fixed encoded length", () => {
  expect(normalizeOpaqueProof32("A")).toBe(`A${".".repeat(42)}`);
});

it("bounds non-base64url characters instead of returning the full input", () => {
  const wrongCharacters = "💥".repeat(43);
  const normalized = normalizeOpaqueProof32(wrongCharacters);

  expect(normalized).toHaveLength(43);
  expect(normalized).not.toBe(wrongCharacters);
});

it("does not accept a valid-looking proof with extra leading text", () => {
  const input = `prefix${validProof}`;
  const normalized = normalizeOpaqueProof32(input);

  expect(normalized).toHaveLength(43);
  expect(normalized).not.toBe(input);
});

it("does not accept a valid-looking proof with extra trailing text", () => {
  expect(normalizeOpaqueProof32(`${validProof}suffix`)).toBe(validProof);
});
