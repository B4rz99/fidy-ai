import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { PATScopes } from "~/core/tokens/model";
import {
  CanonicalCapabilities,
  allCanonicalCapabilities,
  canonicalCapabilitiesFromPATScopes,
} from "./canonical-capability";

it("keeps canonical capabilities distinct from public PAT scopes", () => {
  const decodedPATScopes = Schema.decodeSync(PATScopes)(["write", "read"]);
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
