import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { PatScopes } from "~/core/tokens/model";
import {
  CanonicalCapabilities,
  allCanonicalCapabilities,
  canonicalCapabilitiesFromPatScopes,
} from "./canonical-capability";

it("keeps canonical capabilities distinct from public PAT scopes", () => {
  const decodedPatScopes = Schema.decodeUnknownSync(PatScopes)(["write", "read"]);
  const capabilities = canonicalCapabilitiesFromPatScopes(decodedPatScopes);

  expect(capabilities).toEqual(["write", "read"]);
  expect(capabilities).not.toBe(decodedPatScopes);
  expect(Result.isFailure(Schema.decodeUnknownResult(CanonicalCapabilities)([]))).toBe(true);
  expect(
    Result.isFailure(Schema.decodeUnknownResult(CanonicalCapabilities)(["read", "read"]))
  ).toBe(true);
});

it("grants a hosted Turn every canonical capability exactly once", () => {
  expect(allCanonicalCapabilities).toEqual(["read", "write", "dashboard"]);
  expect(Schema.is(CanonicalCapabilities)(allCanonicalCapabilities)).toBe(true);
});
