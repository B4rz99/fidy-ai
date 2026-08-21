import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { HostedAgentSessionId } from "./hosted-agent-session";

it("accepts only canonical UUID Hosted Agent Session identities", () => {
  const decode = Schema.decodeUnknownResult(HostedAgentSessionId);

  expect(Result.isSuccess(decode("f1d1a000-0000-4000-8000-000000000281"))).toBe(true);
  expect(Result.isFailure(decode("F1D1A000-0000-4000-8000-000000000281"))).toBe(true);
  expect(Result.isFailure(decode("session-281"))).toBe(true);
});
