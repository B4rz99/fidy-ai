import { Effect, Exit, Redacted } from "effect";
import { expect, it, vi } from "vitest";
import { authorizeNequiWithWompi } from "./wompi-nequi";

it("waits for Nequi approval and returns only the token without retaining account evidence", () => {
  const provider = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    expect(url instanceof Request ? url.url : url.toString()).toMatch(
      /^https:\/\/sandbox\.wompi\.co\/v1\/tokens\/nequi/u
    );
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    return Promise.resolve(
      Response.json({
        data: { id: "nequi_test_example", status: "APPROVED", phone_number: "3991111111" },
      })
    );
  });
  return Effect.runPromise(
    authorizeNequiWithWompi({
      publicKey: "pub_test_example",
      phoneNumber: Redacted.make("3991111111"),
      fetch: provider,
      onAwaiting: () => undefined,
    }).pipe(Effect.map((token) => expect(Redacted.value(token)).toBe("nequi_test_example")))
  );
});

it("rejects mismatched, malformed and overflowing provider responses without reflecting their bodies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const response of [
        Response.json({ data: { id: "nequi_prod_other", status: "APPROVED" } }),
        Response.json({ data: { id: "nequi_test_example", status: "unknown" } }),
        new Response("CANARY-account".repeat(2000)),
      ]) {
        const result = yield* Effect.exit(
          authorizeNequiWithWompi({
            publicKey: "pub_test_example",
            phoneNumber: Redacted.make("3991111111"),
            fetch: () => Promise.resolve(response),
            onAwaiting: () => undefined,
          })
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(String(result)).not.toContain("CANARY-account");
      }
    })
  ));
