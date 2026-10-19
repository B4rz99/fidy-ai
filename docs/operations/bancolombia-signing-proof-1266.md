# Bancolombia sandbox signing possession — #1266

The manual `Verify Bancolombia sandbox signing possession` workflow verifies the existing
protected `BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM` against the published sandbox JWKS. It does not
provision or rotate a key, install a Core signer, authenticate to Bancolombia or enable an institution.
A successful run proves possession of that matching key in the protected execution environment;
bank registration and certificate acceptance remain separate evidence.

## Execution boundary

The workflow runs only from protected `trunk`, with read-only repository permission and the
existing `production` environment. It installs the frozen dependency graph without lifecycle scripts,
then fetches the fixed public Fidy JWKS URL over HTTPS without following redirects, bounded to
16 KiB and ten seconds. That step has no signing secret. Only the following offline proof step
receives the existing secret through environment configuration.

The command rejects malformed/oversized or private-bearing JWKS, unexpected key count, key ID or
[RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html#section-3) SHA-256 thumbprint. The expected public identity is pinned in the reviewed command:

- `kid`: `bancolombia-sandbox-2026-10-08`
- Thumbprint: `j1s582zfiR_-eKowck-EajaZmu5oZqx7jPgJtUhy2QE`

The command imports the PKCS#8 private material for signing only, signs a fresh domain-separated
random challenge with RSASSA-PKCS1-v1_5/SHA-256, and verifies against the public key. It returns
only a verified result, algorithm, public key ID and public thumbprint. Failure exits nonzero with
one fixed error. No signature, challenge, JWT, private key or provider credentials are emitted.
The key stays in process memory/environment for that step; no private key file or proof artifact
is uploaded. JavaScript strings cannot be reliably zeroized; no memory-erasure claim is made.

GitHub's run revision/time and safe summary are the operational observation boundary. This one-shot
check needs no application telemetry, retries or durable continuation. Preserve the successful run
URL/revision and minimized output in restricted evidence before changing the possession status in
the [profile worksheet](bancolombia-profile-1266.md). No run is implied by merely merging the workflow.

A changed bank-registered key requires a reviewed update of this pin coordinated with the separate
signing rotation procedure. A proof failure does not authorize replacing either key. Transport
certificate rotation, expiry, TLS handshakes and certificate-bound tokens are not tested here.

## Focused verification

`bun node_modules/vitest/vitest.mjs run --config scripts/vitest.config.ts scripts/bancolombia-signing-proof.test.ts`

The public proof interface exercises real cryptographic match/mismatch, pinned metadata rejection,
private-field/invalid-input refusal, safe failure projection and the command's missing-configuration
exit/output. Ephemeral synthetic keys supply local fixtures; they are not bank credentials or proof
of the protected environment. The root CI tooling suite includes these tests.

## Live result

The successful or failed run URL, revision, time and restricted receipt are recorded in
[#1266](https://github.com/B4rz99/fidy-ai/issues/1266) after actual execution. This runbook alone makes
no live-result claim. Run the reviewed workflow from `trunk`; do not label local fixtures as the
protected-key result. #1266 remains open for bank-specific registration, transport and profile gaps.
