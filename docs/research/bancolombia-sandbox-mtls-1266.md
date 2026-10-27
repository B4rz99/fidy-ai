# Bancolombia sandbox outbound mTLS — #1266

Assessment date: **2026-10-27**. Scope: Cloudflare transport capability and
installed Alchemy support. No certificate, private key, populated credential file,
cloud account state, or bank customer data was read. No cloud mutation or bank
request was performed. The host inventory below comes from the supplied sandbox
configuration, not from general Cloudflare documentation.

## Transport capability

Workers supports an outbound mTLS certificate binding. Its `fetch` interface
presents the uploaded client certificate during TLS establishment. The certificate
and private key must be uploaded to Cloudflare's account-level certificate store;
the Worker binding contains a certificate ID. Application JavaScript therefore
needs the Fetcher capability, not the transport private-key text. Upload requires
the **SSL and Certificates Edit** API permission. Cloudflare documents a blocking
limitation: requests to a Cloudflare-proxied destination fail with **520**.
[Cloudflare Workers mTLS](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/)

The upload accepts a PEM certificate chain plus the corresponding private-key
file. Its result includes certificate ID, issuer and expiration metadata. This is
separate from uploading a CA chain used to verify incoming client certificates;
we must select an outbound leaf credential rather than confuse the two products.
[Cloudflare certificate commands](https://developers.cloudflare.com/workers/wrangler/commands/certificates/)

The API exposes `expires_on`; it does not promise automatic renewal of uploaded
bank-issued credentials. The reviewed upload/runtime documentation also does not
establish local expiry, chain, or key-match validation before upload. Therefore
check validity dates, intended client use, chain completeness and certificate/key
match through a protected local provisioning step, without logging key material.
Treat successful bank TLS authentication as separate evidence from successful
upload. These checks are Fidy implementation recommendations, not an additional
Bancolombia requirement inferred from Cloudflare.
[Certificate API](https://developers.cloudflare.com/api/resources/mtls_certificates/methods/create/)

The separate SSL/TLS documentation's inbound-client and BYOCA quotas must not be
assumed to be the applicable outbound leaf-certificate quota. No definitive
outbound leaf-certificate quota or renewal policy was found in the reviewed
Workers binding/command pages; verify the actual account entitlement if upload
reports a limit.
[Client certificate product distinctions](https://developers.cloudflare.com/ssl/client-certificates/)

## Installed Alchemy support

Verified against installed **`alchemy@2.0.0-beta.80`**, the authority selected by
[the source map](../../.patterns/effect-4-stable.md), rather than the older vendored
snapshot:

- [`MtlsCertificate`](../../node_modules/alchemy/src/Cloudflare/MtlsCertificate/MtlsCertificate.ts)
  supports account-level leaf upload with `ca: false`, PEM `certificates`, and
  `privateKey: Redacted<string>`. It exposes ID/expiry metadata. Changing name,
  certificate, CA flag or private key replaces the resource; this is not renewal.
- [`WorkerBinding`](../../node_modules/alchemy/src/Cloudflare/Workers/WorkerBinding.ts)
  retains Cloudflare's `mtls_certificate` wire binding type, but its
  `WorkerBindingResource` union has no direct `MtlsCertificate` resource arm.
  Do not assume passing the certificate resource directly through `Worker.env`
  creates a native binding.
- [`RuntimeBindings`](../../node_modules/alchemy/src/Cloudflare/Workers/RuntimeBindings.ts)
  handles that wire type through the installed runtime's
  [`MtlsCertificate.remote`](../../node_modules/@alchemy.run/cloudflare-runtime/src/core/bindings/MtlsCertificate.ts).
  Local emulation uses a remote binding; a fixture-only test does not prove a bank
  TLS handshake. Any integration seam must preserve the repository's single
  Alchemy deployment owner and avoid a parallel deployment mechanism.

`Redacted` is a type-level handling mechanism, not evidence that a particular
provisioning/state path avoids retaining the key. Review that path before choosing
an Alchemy-managed upload versus a securely provisioned existing certificate ID.

## Remaining evidence before a real sandbox call

1. Secure availability of the supplied certificate chain and matching transport
   key, or an already-provisioned Cloudflare certificate ID. Their values need not
   be pasted into chat. The JWT signing key is a separate credential use.
2. Validate bank destinations from the accepted sandbox metadata: issuer host
   `auth1-api-open-finance-sandbox.ambientesbc.com`, token host
   `as1-api-open-finance-sandbox.ambientesbc.com`, resource host
   `rs1-api-open-finance-sandbox.ambientesbc.com`. Establish their compatibility
   with the Cloudflare-proxy limitation; this note did not inspect DNS or contact
   them. Do not substitute the production-looking hosts in the earlier email.
3. Apply the bank's supplied instructions to determine which operations require
   the certificate, any certificate-bound-token behavior, and whether extra CA,
   egress allowlisting or transport restrictions apply. General Cloudflare docs
   cannot establish Bancolombia's accepted profile.
4. After provisioning, run a bounded sandbox handshake/protocol test with safe
   failure reporting. Production remains unavailable according to the user; this
   research neither provisions nor enables it.
