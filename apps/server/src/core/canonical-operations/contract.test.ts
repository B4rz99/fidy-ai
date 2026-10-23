import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  CanonicalCapabilities,
  CanonicalCapability,
  CanonicalOperationId,
  allCanonicalCapabilities,
  canonicalCapabilitiesFromPATScopes,
} from "./contract";

it("copies credential scopes into a closed canonical capability set", () => {
  const decodedPATScopes = Schema.decodeSync(Schema.Array(CanonicalCapability))(["write", "read"]);
  const capabilities = canonicalCapabilitiesFromPATScopes(decodedPATScopes);

  expect(capabilities).toEqual(["write", "read"]);
  expect(capabilities).not.toBe(decodedPATScopes);
  expect(Result.isFailure(Schema.decodeResult(CanonicalCapabilities)([]))).toBe(true);
  expect(Result.isFailure(Schema.decodeResult(CanonicalCapabilities)(["read", "read"]))).toBe(true);
});

it("grants a hosted Turn every canonical capability exactly once", () => {
  expect(allCanonicalCapabilities).toEqual(["read", "write", "dashboard"]);
  expect(Schema.is(CanonicalCapabilities)(allCanonicalCapabilities)).toBe(true);
});

it("accepts complete group-operation identities and rejects extra separators or surrounding text", () => {
  const decode = Schema.decodeUnknownResult(CanonicalOperationId);
  for (const value of ["a.b", "transactions.searchHistory2"]) {
    expect(Result.isSuccess(decode(value))).toBe(true);
  }
  for (const value of [".b", "a.", "A.b", "a.B", "a..b", "a_b", "!a.b", "a.b!", "a.b\n", "1a.b"]) {
    expect(Result.isFailure(decode(value))).toBe(true);
  }
});
