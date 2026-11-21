import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { browserOrigins } from "../runtime/contract";
import type { AnonymousAdmissionRequest } from "./contract";

const minimumAdmissionKeyLength = 32;

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
      return yield* Effect.die(new Error("PAT admission unavailable"));
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
