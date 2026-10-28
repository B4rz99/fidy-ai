import { describe, expect, it } from "vitest";
import { destinationAfterLogin } from "./login-destination";

const request = "24000000-0000-4000-8000-000000000123";

describe("login continuation", () => {
  it.each([
    [{ cliCode: "BCDF-GHJK" }, "/connect/cli?cliCode=BCDF-GHJK"],
    [{ oauthRequest: request }, `/oauth/review/${request}`],
    [{ connectionAttempt: request }, `/connections/continue?attempt=${request}`],
    [{ resume: "pat" }, "/settings/access?resume=pat"],
    [{ resume: "account" }, "/settings/account"],
    [{ resume: "access" }, "/settings/access"],
  ])("preserves the fixed pending task for %o", (search, destination) => {
    expect(destinationAfterLogin(search)).toBe(destination);
  });

  it.each([
    {},
    { redirect: "https://attacker.example" },
    { returnTo: "//attacker.example" },
    { resume: "https://attacker.example" },
    { cliCode: "../../private" },
    { oauthRequest: "invalid" },
    { oauthOperation: "invalid" },
    { oauthOperation: request },
    { connectionAttempt: "invalid" },
    { handoff: request },
  ])("cannot turn a link into arbitrary navigation or approval: %o", (search) => {
    expect(destinationAfterLogin(search)).toBe("/app/transactions");
  });
});
