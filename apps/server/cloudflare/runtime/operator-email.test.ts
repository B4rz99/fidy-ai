import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { sendOperatorEmail as sendEmail } from "./operator-email";

const sendOperatorEmail = (
  input: Omit<Parameters<typeof sendEmail>[0], "signal" | "phase">
): Promise<void> => sendEmail({ ...input, phase: "firing", signal: new AbortController().signal });

const testInput = {
  alert: { kind: "dead_letters", owner: "deadLetters", severity: "critical" },
  idempotencyKey: "fidy-test-alert",
  to: "operator@example.com",
  apiKey: "secret-canary",
  release: "0".repeat(40),
} as const;

it.effect("sends only closed operational coordinates to the operator email", () => {
  let body = "";
  return Effect.scoped(
    Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(globalThis, "fetch").mockImplementation((request, init) =>
          new Request(request, init).text().then((text) => {
            body = text;
            return new Response('{"id":"accepted-id"}', {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          })
        )
      ),
      () =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => sendOperatorEmail(testInput));
          expect(body).toContain("dead_letters");
          expect(body).not.toContain("secret-canary");
          expect(body).not.toContain("userId");
        }),
      (fetch) => Effect.sync(() => fetch.mockRestore())
    )
  );
});

it.effect("rejects a malformed provider acknowledgement rather than reporting email success", () =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.sync(() =>
        vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(() =>
            Promise.resolve(new Response('{"unexpected":"private"}', { status: 200 }))
          )
      ),
      () =>
        Effect.tryPromise(() =>
          expect(sendOperatorEmail(testInput)).rejects.toThrow(
            "Operator email delivery unavailable"
          )
        ),
      (fetch) => Effect.sync(() => fetch.mockRestore())
    )
  )
);
