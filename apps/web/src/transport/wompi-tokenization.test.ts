import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  CardTokenizationFailed,
  type WompiFetch,
  tokenizeCardWithWompi,
} from "./wompi-tokenization";

const card = {
  number: "4242 4242 4242 4242",
  cvc: "123",
  expirationMonth: "8",
  expirationYear: "2030",
  cardholderName: "Ada Lovelace",
};

describe("Wompi browser tokenization", () => {
  it("sends card details straight to Sandbox and retains only the returned token", async () => {
    const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "tok_test_browser_only", brand: "VISA" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).resolves.toBe("tok_test_browser_only");
    expect(fetchStub).toHaveBeenCalledWith(
      "https://sandbox.wompi.co/v1/tokens/cards",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          number: "4242424242424242",
          cvc: "123",
          exp_month: "08",
          exp_year: "30",
          card_holder: "Ada Lovelace",
        }),
      })
    );
  });

  it("rejects card networks outside the approved recurring launch set", async () => {
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "tok_test_amex", brand: "AMEX" } }))
      );

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });

  it("stops reading a provider response at the browser-owned byte limit", async () => {
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(new Response("x".repeat(16_385), { status: 200 }));

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });

  it("turns malformed provider responses into one detail-free failure", async () => {
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(new Response(JSON.stringify({ provider_secret: "unexpected" })));

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });
});
