import { Crypto, Effect, Encoding } from "effect";
import type { TokenBearer } from "~/core/tokens/model";
import { TokenHash } from "~/shell/tokens/repo";

/** Hashes one opaque bearer for digest-only token persistence and lookup. */
export const hashTokenBearer = (
  bearer: TokenBearer
): Effect.Effect<TokenHash, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.digest("SHA-256", new TextEncoder().encode(bearer))
  ).pipe(
    Effect.map((digest) => TokenHash.make(Encoding.encodeHex(digest))),
    Effect.orDie
  );
