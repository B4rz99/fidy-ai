# Effect v4 crypto, encoding, and secret handling

Selected sources: `node_modules/effect/src/Crypto.ts`, `Redacted.ts`, and
`encoding/{Base64,Base64Url,Hex,EncodingError}.ts` under the same source directory.
See [the source map](effect-4-stable.md) for release versus upstream authority.

Use this pattern when generating identifiers or bearer secrets, hashing, encoding binary values, comparing secret-derived values, or handling `Redacted` configuration.

## Separate the concerns

| Concern                           | API                                                 | Security property                                                        |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Entropy, UUIDs, ULIDs, SHA digest | `Crypto.Crypto`                                     | Platform-backed cryptographic implementation                             |
| Binary-to-text representation     | `Base64`, `Base64Url`, `Hex` from `effect/encoding` | Reversible encoding only; no secrecy or authenticity                     |
| Accidental display/log protection | `Redacted`                                          | Presentation guard only; not encryption or access control                |
| Constant-time byte comparison     | platform `timingSafeEqual`                          | Reduces timing leakage for equal-length secret-derived bytes             |
| Password storage                  | dedicated password KDF                              | Salted, work-factor-controlled password hashing; plain SHA is unsuitable |
| Message authentication            | protocol/library HMAC or signature primitive        | Authenticity; a bare digest is not a MAC                                 |

Never describe Base64, Base64Url, or hex as encryption. Never describe `Redacted` as secure storage.

## Entropy and digests

Request `Crypto.Crypto` inside the effect and provide the platform layer once at the runtime edge.
The Cloudflare Worker adapter uses Web Crypto for entropy and digests; portable tests use the
repository's deterministic `TestCrypto` seam rather than a process-runtime service.

```ts
import { Crypto, Effect, Redacted } from "effect";
import { Base64Url } from "effect/encoding";

const makeBearer = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(32);
  return Redacted.make(Base64Url.encode(bytes));
});
```

`Crypto.make` validates `randomBytes(size)` as a non-negative safe integer and exposes a
`PlatformError` channel; `digest` also exposes `PlatformError`. Its underlying synchronous entropy
callback can still throw a defect. Decide at the owning adapter whether platform failure is
recoverable. Use `Effect.orDie` only where failure means a broken runtime, not business recovery.

Rules:

- Generate bearer secrets, verification entropy, nonces, and security identities from `Crypto.Crypto.randomBytes`, never `Math.random`, timestamps, counters, or `Hex.random`.
- Choose entropy in bytes first, then encode. Hex emits two characters per byte; Base64Url is denser and URL/header safe.
- Use SHA-256 or stronger for fingerprints and lookup digests. SHA-1 exists for interoperability, not new security designs.
- A fast digest does not make a low-entropy code safe against offline guessing. Include enough entropy or use a protocol-specific KDF/pepper design.
- Hash the canonical bytes, not an ambiguously concatenated string. For multi-field proofs, use an unambiguous length-prefix/canonical encoding or a protocol-defined construction.
- `randomUUIDv4`, `randomUUIDv7`, and `randomULID` produce identifiers, not bearer credentials.
  Use explicit random bytes for secrets. ULIDs expose their creation time: their first 10 Crockford
  base32 characters encode the `Clock` timestamp in milliseconds and the remaining 16 encode 80
  random bits (see `Crypto.make` and `randomULID`). Use that sortability only when timestamp disclosure
  is acceptable; it adds no secrecy.

## Encoding is a boundary with failure

Use `Base64.encode/decode`, `Base64Url.encode/decode`, and `Hex.encode/decode` from
`effect/encoding`. Encoders accept UTF-8 strings or bytes; decoders return
`Result<Uint8Array, EncodingError>`. Each module's `decodeString` converts to UTF-8 text.

`Base64Url.encode` emits unpadded URL-safe text, but its decoder accepts padded and unpadded
forms and strips CR/LF. Base64 also strips CR/LF and requires valid length/padding. Hex requires
even length and valid characters. Successful decoding therefore does **not** prove a canonical
credential spelling. Enforce the protocol's alphabet and padding rules, and compare re-encoding
when canonical spelling is required. `EncodingError` retains input: map it to a safe failure
rather than logging or exposing it.

At an untrusted boundary:

1. enforce encoded length before decoding;
2. decode and handle `EncodingError` explicitly;
3. enforce decoded byte length;
4. parse/validate the decoded value with Schema;
5. map failure to the boundary's declared safe error.

Do not silently fall back to empty bytes or an empty secret after decode failure. Avoid `decodeString` for arbitrary binary content, and remember that `TextDecoder`'s default UTF-8 decoding is not a canonical validation step by itself.

`Hex.random` uses `Math.random()` and rounds lengths via unsigned 32-bit behavior. Reserve it
for throwaway labels where unpredictability does not matter; secure hex starts with
`crypto.randomBytes` followed by `Hex.encode`.

## Secret lifetime and redaction

Use `Config.redacted` for secret configuration and carry `Redacted.Redacted<A>` through ports and application services. Unwrap with `Redacted.value` only at the narrow adapter call that requires plaintext.

`Redacted` prevents ordinary inspection/stringification from revealing a value. Once unwrapped, the plain value can leak through logs, errors, traces, metrics, URLs, serialized requests, retained closures, or persistence. Therefore:

- never log or interpolate unwrapped secrets;
- never attach them to span attributes or metric labels;
- keep credentials out of URL paths/query strings;
- mark sensitive HTTP headers for redaction and verify adapter behavior;
- do not persist a recoverable bearer token when a lookup digest suffices;
- do not return private verification material from boundaries that do not need it;
- avoid embedding secret values in error messages or schema issues.

Redaction and zeroization are different. JavaScript strings and copied buffers cannot be reliably scrubbed. Minimize materialization, copies, scope, and lifetime instead of claiming memory erasure.

## Constant-time verification

For secret-derived proofs:

1. decode/derive the candidate into bytes;
2. reject length mismatch before comparison;
3. call `timingSafeEqual` only with equal-length buffers;
4. return one coarse public authentication failure regardless of mismatch reason.

```ts
import { timingSafeEqual } from "node:crypto";

const sameDigest = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);
```

Constant-time equality does not repair a weak protocol. Verify the exact signed bytes, preserve raw request bodies when required by webhook protocols, reject stale/replayed messages where the protocol supports timestamps/nonces, and use the vendor's maintained verification library when available.

The comparison example belongs in a platform adapter with `node:crypto` support (including a
Worker with the required compatibility configuration), not portable domain code.
Direct platform crypto is appropriate at an adapter for primitives Effect does not expose, such as
constant-time equality or HMAC. Keep platform imports out of pure domain modules and hide them behind
a small named function/port when behavior needs deterministic testing.

## Storage patterns

### Bearer token

- Generate at least the protocol's reviewed entropy budget.
- Return the plaintext exactly once as `Redacted`.
- Persist a domain-separated digest and non-secret short ID, not the bearer.
- On authentication, decode strictly, find by short ID, recompute the digest, and compare in constant time.
- Bind revocation, expiry, and ownership checks to the same authorization transaction.

### Verification code

- Treat combined codes and private verifiers as `Redacted` even when short-lived.
- Persist only the proof needed for verification.
- Rate-limit attempts and expire one-time challenges.
- Consume a challenge atomically so concurrent/replayed submissions cannot both succeed.

### Content fingerprint

- Define canonical input bytes and algorithm in the domain contract.
- Store algorithm/version with the digest if either may evolve.
- A fingerprint supports equality/deduplication, not authenticity.

## Testing

Prefer a deterministic `Crypto.make` service for focused logic tests; return fresh byte arrays and
model digest failure when relevant. Keep integration coverage with the Cloudflare Web Crypto adapter.

Test:

- exact entropy and encoded lengths;
- invalid, non-canonical, and oversized encodings;
- digest vectors/canonical input ordering;
- equal, unequal, and unequal-length comparisons;
- duplicate/replay and atomic consumption behavior;
- serialized errors, logs, traces, and responses do not contain secret fixtures;
- platform crypto failures follow the chosen failure policy.
