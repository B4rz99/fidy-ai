import { expect, it } from "@effect/vitest";
import { Option } from "effect";
import {
  ConfirmationDigest,
  confirmationCommandFromChallenge,
  confirmationDigestFromChallenge,
  confirmationDigestFromCommand,
  renderConfirmationChallengeText,
} from "./tool-confirmation-model";

const digest = ConfirmationDigest.make("a".repeat(64));
const commandPrefix = "CONFIRMAR pats.revokeAllPATs ";
const command = `${commandPrefix}${digest}`;

it("owns exact confirmation challenge framing and digest extraction", () => {
  const challenge = renderConfirmationChallengeText({
    challengeBody: "Confirma esta operación.",
    commandPrefix,
    digest,
  });

  expect(Option.getOrThrow(confirmationCommandFromChallenge(challenge))).toBe(command);
  expect(Option.getOrThrow(confirmationDigestFromChallenge(challenge))).toBe(digest);
  expect(Option.getOrThrow(confirmationDigestFromCommand(command))).toBe(digest);
});

it("rejects text outside the exact confirmation command and challenge framing", () => {
  expect(Option.isNone(confirmationCommandFromChallenge(command))).toBe(true);
  expect(Option.isNone(confirmationDigestFromCommand(`ACEPTAR ${digest}`))).toBe(true);
  expect(Option.isNone(confirmationDigestFromCommand("CONFIRMAR"))).toBe(true);
  expect(Option.isNone(confirmationDigestFromCommand(`${commandPrefix}invalid`))).toBe(true);
});
