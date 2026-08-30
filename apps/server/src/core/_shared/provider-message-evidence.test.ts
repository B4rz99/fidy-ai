import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { ProviderMessageEvidence } from "./provider-message-evidence";

const evidence = {
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId: "wamid.acceptance-101",
};

it("retains one provider-qualified message without treating it as identity", () => {
  expect(Schema.decodeSync(ProviderMessageEvidence)(evidence)).toEqual(evidence);
});

it("rejects blank, untrimmed, and oversized evidence fields", () => {
  const decode = Schema.decodeUnknownResult(ProviderMessageEvidence);

  expect(Result.isFailure(decode({ ...evidence, channel: " " }))).toBe(true);
  expect(Result.isFailure(decode({ ...evidence, provider: " kapso" }))).toBe(true);
  expect(Result.isFailure(decode({ ...evidence, providerMessageId: "m".repeat(257) }))).toBe(true);
});
