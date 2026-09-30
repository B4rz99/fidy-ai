import { Schema } from "effect";
import { expect, it } from "vitest";
import { AuthenticatedBrowserLoginPairing } from "./contract";

it("publishes redemption success without bearer or User material", () => {
  const encode = Schema.encodeSync(Schema.toCodecJson(AuthenticatedBrowserLoginPairing));
  expect(
    encode({
      status: "authenticated",
      userId: "private-user",
      bearer: "private-bearer",
    })
  ).toEqual({ status: "authenticated" });
});
