import { expect, it, vi } from "vitest";
import { sendOperatorEmail as sendEmail } from "./operator-email";

const sendOperatorEmail = (input: Omit<Parameters<typeof sendEmail>[0], "signal">): Promise<void> =>
  sendEmail({ ...input, signal: new AbortController().signal });

it("sends only closed operational coordinates to the operator email", async () => {
  let body = "";
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    body = await new Request(request, init).text();
    return new Response('{"id":"accepted-id"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    await sendOperatorEmail({
      alert: { kind: "dead_letters", owner: "deadLetters", severity: "critical" },
      idempotencyKey: "fidy-test-alert",
      to: "operator@example.com",
      apiKey: "secret-canary",
      release: "0".repeat(40),
    });
    expect(body).toContain("dead_letters");
    expect(body).not.toContain("secret-canary");
    expect(body).not.toContain("userId");
  } finally {
    fetch.mockRestore();
  }
});

it("rejects a malformed provider acknowledgement rather than reporting email success", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response('{"unexpected":"private"}', { status: 200 }));
  try {
    await expect(
      sendOperatorEmail({
        alert: { kind: "dead_letters", owner: "deadLetters", severity: "critical" },
        idempotencyKey: "fidy-test-alert",
        to: "operator@example.com",
        apiKey: "secret-canary",
        release: "0".repeat(40),
      })
    ).rejects.toThrow("Operator email delivery unavailable");
  } finally {
    fetch.mockRestore();
  }
});
