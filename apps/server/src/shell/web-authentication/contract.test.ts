import { Schema } from "effect";
import { expect, it } from "vitest";
import { AuthenticatedBrowserLoginPairing } from "./contract";

it("publishes redemption success without bearer or User material", () => {
  const encode = Schema.encodeSync(Schema.toCodecJson(AuthenticatedBrowserLoginPairing));
  const reply = {
    status: "authenticated" as const,
    userId: "private-user",
    bearer: "private-bearer",
  };
  expect(encode(reply)).toEqual({ status: "authenticated" });
});
