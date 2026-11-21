import { Effect } from "effect";
import { Base64Url } from "effect/encoding";

const fixtureMac = Effect.fn(function* (secret: string, content: string) {
  const key = yield* Effect.tryPromise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
  );

  return Base64Url.encode(
    new Uint8Array(
      yield* Effect.tryPromise(() =>
        crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content))
      )
    )
  );
});

type AuthCode = {
  host: "acceptance" | "production";
  subject: string;
  nonce: string;
  challenge: string;
  deadline: number;
  provider: "google" | "microsoft";
};

const codeFields = (input: AuthCode): string =>
  [
    input.provider,
    input.host,
    input.subject,
    input.nonce,
    input.challenge,
    String(input.deadline),
  ].join(".");

export const issueAcceptanceProviderCode = Effect.fn(function* (input: AuthCode, secret: string) {
  const fields = codeFields(input);

  return fields + "." + (yield* fixtureMac(secret, fields));
});
