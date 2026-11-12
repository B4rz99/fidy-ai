import { Effect, Exit, Redacted } from "effect";
import { expect, it, vi } from "vitest";
import { NequiAuthorizationFailed, withApprovedNequiWithWompi } from "./wompi-nequi";

it("refuses rejected authorization without waiting for provider cancellation", () => {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel(): Promise<void> {
      cancellations++;
      return Promise.withResolvers<void>().promise;
    },
  });
  return expect(
    Effect.runPromise(
      withApprovedNequiWithWompi(
        {
          publicKey: "pub_test_example",
          phoneNumber: Redacted.make("3991111111"),
          fetchImplementation: () => Promise.resolve(new Response(body, { status: 422 })),
          clearPhone: () => undefined,
          onAwaiting: () => undefined,
        },
        (token) => Effect.succeed(Redacted.value(token))
      )
    )
  )
    .rejects.toBeInstanceOf(NequiAuthorizationFailed)
    .then(() => {
      expect(cancellations).toBe(1);
      expect(body.locked).toBe(false);
    });
});

it("borrows only the approved Nequi token without retaining account evidence", () => {
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
    withApprovedNequiWithWompi(
      {
        publicKey: "pub_test_example",
        phoneNumber: Redacted.make("3991111111"),
        fetchImplementation: provider,
        clearPhone: () => undefined,
        onAwaiting: () => undefined,
      },
      (token) => Effect.sync(() => expect(Redacted.value(token)).toBe("nequi_test_example"))
    )
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
          withApprovedNequiWithWompi(
            {
              publicKey: "pub_test_example",
              phoneNumber: Redacted.make("3991111111"),
              fetchImplementation: () => Promise.resolve(response),
              clearPhone: () => undefined,
              onAwaiting: () => undefined,
            },
            (token) => Effect.succeed(Redacted.value(token))
          )
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(String(result)).not.toContain("CANARY-account");
      }
    })
  ));
