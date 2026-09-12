# Effect v4 crypto, encoding, and secret handling

Project baseline: `effect@4.0.0-rc.112`; source checkout `.repos/effect` at `f239b5b6cc`.

Use this pattern when generating identifiers or bearer secrets, hashing, encoding binary values, comparing secret-derived values, or handling `Redacted` configuration.

## Separate the concerns

| Concern                           | API                                          | Security property                                                        |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| Entropy, UUIDs, SHA digest        | `Crypto.Crypto`                              | Platform-backed cryptographic implementation                             |
| Binary-to-text representation     | `Encoding`                                   | Reversible encoding only; no secrecy or authenticity                     |
| Accidental display/log protection | `Redacted`                                   | Presentation guard only; not encryption or access control                |
| Constant-time byte comparison     | platform `timingSafeEqual`                   | Reduces timing leakage for equal-length secret-derived bytes             |
| Password storage                  | dedicated password KDF                       | Salted, work-factor-controlled password hashing; plain SHA is unsuitable |
| Message authentication            | protocol/library HMAC or signature primitive | Authenticity; a bare digest is not a MAC                                 |

Never describe Base64, Base64Url, or hex as encryption. Never describe `Redacted` as secure storage.

## Entropy and digests

Request `Crypto.Crypto` inside the effect and provide the platform layer once at the runtime edge. Bun's layer delegates to the shared Node-compatible implementation, which uses `node:crypto.randomBytes` and `createHash` (`.repos/effect/packages/platform/bun/src/BunCrypto.ts:14-31`, `.repos/effect/packages/platform/node-shared/src/NodeCrypto.ts:16-61`).

```ts
const makeBearer = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(32);
  return Redacted.make(Encoding.encodeBase64Url(bytes));
});
```

`randomBytes(size)` validates that size is a non-negative safe integer and can fail with `PlatformError`; `digest` can also fail with `PlatformError` (`.repos/effect/packages/effect/src/Crypto.ts:213-299`). Decide at the owning boundary whether platform crypto failure is recoverable. `Effect.orDie` is acceptable only where failure means the configured runtime is broken and retry/business recovery is meaningless; do not scatter it through domain logic.

Rules:

- Generate bearer secrets, verification entropy, nonces, and security identities from `Crypto.Crypto.randomBytes`, never `Math.random`, timestamps, counters, or `Encoding.randomHex`.
- Choose entropy in bytes first, then encode. Hex emits two characters per byte; Base64Url is denser and URL/header safe.
- Use SHA-256 or stronger for fingerprints and lookup digests. SHA-1 exists for interoperability, not new security designs.
- A fast digest does not make a low-entropy code safe against offline guessing. Include enough entropy or use a protocol-specific KDF/pepper design.
- Hash the canonical bytes, not an ambiguously concatenated string. For multi-field proofs, use an unambiguous length-prefix/canonical encoding or a protocol-defined construction.
- Random UUIDs are identifiers, not bearer credentials. Use explicit random bytes for secrets.

## Encoding is a boundary with failure

Encoding functions accept strings as UTF-8 or raw `Uint8Array`s. Decode functions return `Result<Uint8Array, EncodingError>` (or strings), rather than throwing. Base64Url accepts padded and unpadded forms; Base64 requires valid padding; hex requires even length and valid characters (`.repos/effect/packages/effect/src/Encoding.ts:147-251,290-376,405-517`).

At an untrusted boundary:

1. enforce encoded length before decoding;
2. decode and handle `EncodingError` explicitly;
3. enforce decoded byte length;
4. parse/validate the decoded value with Schema;
5. map failure to the boundary's declared safe error.

Do not silently fall back to empty bytes or an empty secret after decode failure. Avoid `decode*String` for arbitrary binary content, and remember that `TextDecoder`'s default UTF-8 decoding is not a canonical validation step by itself.

`Encoding.randomHex` uses `Math.random()` and rounds lengths via unsigned 32-bit behavior. It is explicitly non-cryptographic (`Encoding.ts:405-449`); reserve it for throwaway labels where unpredictability does not matter.

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
const sameDigest = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);
```

Constant-time equality does not repair a weak protocol. Verify the exact signed bytes, preserve raw request bodies when required by webhook protocols, reject stale/replayed messages where the protocol supports timestamps/nonces, and use the vendor's maintained verification library when available.

Direct `node:crypto`/Bun crypto is appropriate at a platform adapter for primitives Effect does not expose, such as constant-time equality or HMAC. Keep direct imports out of pure domain modules and hide them behind a small named function/port when behavior needs deterministic testing.

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

Prefer a deterministic `Crypto.make` service for focused logic tests; return fresh byte arrays and model digest failure when relevant. Keep integration coverage with the real Bun crypto layer.

Test:

- exact entropy and encoded lengths;
- invalid, non-canonical, and oversized encodings;
- digest vectors/canonical input ordering;
- equal, unequal, and unequal-length comparisons;
- duplicate/replay and atomic consumption behavior;
- serialized errors, logs, traces, and responses do not contain secret fixtures;
- platform crypto failures follow the chosen failure policy.
