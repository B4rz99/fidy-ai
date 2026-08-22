# Browser-pairing security bounds

## Question

Which concrete verifier, public-code, polling, attempt, and error-handling bounds should govern Fidy's browser-paired web authentication?

This note uses OAuth device authorization and PKCE as primary-source analogues. Fidy is not claiming OAuth protocol compatibility; it adopts their reviewed proof-of-possession and human-code security properties.

## Primary-source findings

1. RFC 7636 recommends a cryptographically random 32-octet verifier, base64url encoded to 43 characters, with at least 256 bits of entropy. It defines the `S256` proof as the base64url encoding of SHA-256 over the ASCII verifier and says new implementations should not use the plain verifier as the stored challenge. [RFC 7636 §§4.1–4.2, 7.1–7.2](https://www.rfc-editor.org/rfc/rfc7636.html#section-4.1)
2. RFC 7636 explicitly says salting the challenge is unnecessary because a 256-bit verifier already has sufficient entropy. A separate pepper or custom verifier-derivation secret is therefore not required for this threat. [RFC 7636 §7.3](https://www.rfc-editor.org/rfc/rfc7636.html#section-7.3)
3. RFC 8628 requires finite-lived device and user codes, defines a five-second default minimum polling interval, requires clients to wait at least that interval, and increases the interval by five seconds after `slow_down`. It recommends exponential backoff after connection timeouts. [RFC 8628 §§3.2, 3.5](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.2)
4. RFC 8628 recommends rate-limiting public user-code attempts. Its worked example says an eight-character base-20 code has roughly 34.5 bits of entropy and allowing only five attempts during its validity period yields about a 2^-32 random-guess success probability. [RFC 8628 §5.1](https://www.rfc-editor.org/rfc/rfc8628.html#section-5.1)
5. RFC 8628 recommends an eight-character, case-insensitive consonant alphabet `BCDFGHJKLMNPQRSTVWXZ`, grouped for readability (for example, `WDJB-MJHT`), and normalization that removes presentation punctuation and uppercases input. It recommends avoiding visually confusable characters. [RFC 8628 §6.1](https://www.rfc-editor.org/rfc/rfc8628.html#section-6.1)
6. RFC 8628 identifies remote phishing as a device-flow risk. It recommends telling the User that they are authorizing a device and having them confirm that the displayed code matches the device in their possession. [RFC 8628 §5.4](https://www.rfc-editor.org/rfc/rfc8628.html#section-5.4)
7. OWASP recommends generic authentication failures to avoid account enumeration, login throttling with a maximum attempt count, counters associated with the account rather than solely with source IP, and logging/monitoring authentication failures without exposing credentials. [OWASP Authentication Cheat Sheet: Authentication Responses and Login Throttling](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-responses)
8. OAuth Security BCP requires transaction-specific proof bound to the user agent where the transaction began and recommends S256-style proof rather than exposing a verifier in an authorization request. [RFC 9700 §2.1.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1)

## Locked conclusions for Fidy

### Private verifier

- Generate exactly 32 cryptographically random octets for each browser challenge.
- Encode them as unpadded base64url: exactly 43 ASCII characters.
- Return the raw verifier once in the HTTPS challenge-start response with `Cache-Control: no-store`.
- Hold it only in the `/auth/pair` page's in-memory authentication registry. Do not use URLs, rendered markup, `localStorage`, `sessionStorage`, IndexedDB, service-worker caches, analytics, diagnostics, logs, Transcript, model context, or recoverable server storage.
- Persist exactly `SHA-256(ASCII(verifier))` as 32 bytes. No salt, pepper, signing key, encrypted raw verifier, or custom cryptography is added.
- Treat the raw verifier as `Redacted` at every server boundary where it transiently exists and compare its digest using the platform's constant-time byte comparison.

### Public user code

- Generate eight uniformly random characters from `BCDFGHJKLMNPQRSTVWXZ` (base 20, about 34.6 bits).
- Display as `XXXX-XXXX`.
- Accept lowercase input and an omitted ASCII hyphen; trim surrounding ASCII whitespace. After normalization, require exactly eight characters from the locked alphabet. Do not apply Unicode compatibility folding or silently discard arbitrary characters.
- Keep the code globally unique among live challenges. It is public, may cross WhatsApp and Transcript for approval, and is never sufficient to create a session.
- Expire the code and verifier together exactly ten minutes after challenge creation.

### Explicit hosted approval

- Only a hosted Turn rooted in a verified WhatsApp association may invoke `browserLogin.approvePairing`; PAT, MCP, CLI, browser-session, and anonymous callers cannot invoke or see it as eligible.
- The exact `pairingId` remains browser-side. The hosted operation accepts only `{ publicCode }`; resolved authority supplies the stable `UserId`.
- Sending a browser-prefilled “Approve browser login code XXXX-XXXX” message identifies the requested security action, but the existing hosted confirmation mechanism must still present the matching code and require explicit approve/deny before execution. This follows the repository's existing confirmation seam instead of adding a special parser.
- The first successful approval binds the unbound challenge to that stable `UserId` and makes it Ready. It atomically supersedes every older Ready challenge for the User. An approved challenge cannot be rebound.

### Attempt and request bounds

- A stable User gets at most five failed public-code approval submissions in a rolling ten-minute window. The sixth fails with `429` and `Retry-After` equal to the window's remaining whole seconds. A successful approval clears no evidence and does not make an older failed attempt disappear.
- An individual challenge accepts at most five wrong-verifier redemption attempts. The fifth makes that challenge terminally invalid; a correct concurrent redemption can win only if it atomically consumes the challenge first.
- The anonymous challenge-start endpoint permits a burst of five and at most ten starts per source IP in a rolling ten-minute window, then returns `429` with `Retry-After`. This is an abuse bound, never identity or authorization evidence. The deployment also caps all live unbound challenges at 10,000; capacity rejection is generic and creates no row.
- The browser polls no faster than once every five seconds and keeps at most one poll in flight. A too-fast poll returns `429` with `Retry-After`; each repeated violation adds five seconds to that challenge's required interval. A transport timeout doubles the client interval up to the challenge expiry.
- Expiry terminates polling. The browser never silently creates a replacement challenge; restart requires an explicit User action.

### State, errors, and evidence

- The challenge lifecycle is `PendingApproval -> Ready -> Consumed`, with `PendingApproval|Ready -> Expired`, `Ready -> Superseded`, and terminal invalidation after the wrong-verifier bound. Terminal states never return to Ready.
- Approval binding, supersession, and their metadata-only audit outcome are one transaction. Correct-verifier consumption and WebSession creation are one transaction. Exactly one concurrent redemption can create a session.
- Unknown, malformed, expired, superseded, rebound, invalidated, wrong-verifier, and already-consumed browser attempts use the same status, schema, message, and approximately equivalent bounded work. The UI says: “This pairing is no longer valid. Start again.”
- Approval failures reveal no User, WhatsApp association, pairing existence, stored code, verifier digest, or lifecycle state. Audit, telemetry, and rate-limit evidence contain only safe operation/outcome/reason enums, timestamps, and safe identifiers where already permitted—never the code or verifier.

## Scope allocation

- Issue #238 owns challenge foundation, the typed challenge-start contract, hosted-only approval, code/attempt admission, and approval/supersession atomicity.
- Issue #240 owns SPA memory handling, polling behavior, correct-verifier redemption, WebSession creation, cookie establishment, replay/error UI, and Playwright evidence.
- Issue #239's durable WhatsApp instruction worker is unnecessary for the chosen browser-first flow and should be closed as obsolete.

## Remaining questions

None for the security bounds above. Operational tuning may tighten the anonymous IP/global capacity limits after observed launch traffic, but changing them must remain explicit configuration and cannot weaken the verifier, code entropy, five-attempt, ten-minute, single-use, or no-secret-evidence invariants.
