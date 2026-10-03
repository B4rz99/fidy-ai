import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { browserOrigins } from "../runtime/contract";
import type { AnonymousAdmissionRequest } from "./contract";

const minimumAdmissionKeyLength = 32;

/**
 * Derive a keyed, content-free source identity for anonymous abuse accounting. The public Worker
 * must supply Cloudflare's trusted request and its own configuration, never caller-selected
 * admission policy. Only the configured local topology may substitute a fixed local source.
 * Missing authoritative source or unusable key fails closed before any pairing is forwarded.
 */
export const deriveAnonymousSource = ({
  request,
  browserOrigin,
  admissionKey,
}: AnonymousAdmissionRequest): Effect.Effect<string, void> =>
  Effect.gen(function* () {
    const visitor =
      request.headers.get("cf-connecting-ip") ??
      (browserOrigin === browserOrigins.local ? "local-development" : "");
    if (visitor.length === 0 || admissionKey.length < minimumAdmissionKeyLength) {
      throw new Error("PAT admission unavailable");
    }
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(admissionKey),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        ),
      catch: () => undefined,
    });
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(visitor)),
      catch: () => undefined,
    });
    return Hex.encode(new Uint8Array(signature));
  });
