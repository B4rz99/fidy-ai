import { Encoding } from "effect";
import { type TokenBearer, bearerSecretBytes } from "~/core/tokens/model";

const encodedSecretLength = Encoding.encodeBase64Url(new Uint8Array(bearerSecretBytes)).length;

/**
 * The secret segment of a generated bearer. Persistence proofs use it to assert that no secret
 * material — not even the segment without its `fin_` prefix — reaches a stored row.
 */
export const bearerSecret = (bearer: TokenBearer): string => bearer.slice(-encodedSecretLength);
