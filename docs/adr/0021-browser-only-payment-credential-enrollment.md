# Isolate payment-credential enrollment from canonical authority

Reusable payment-source enrollment uses a dedicated first-party browser API rather than a canonical operation. This deliberately sacrifices define-once canonical derivation so transient provider tokens cannot become representable to PATs, hosted agents, OpenAPI, chat, logs, or persistence; the exception is limited to exact-origin, fresh-WebSession, current-Consent enrollment with bounded no-store transport and browser-safe projections. Ambiguous available outcomes are settled only after a server-side authenticated Wompi lookup confirms that the source is available and carries the retained enrollment billing email.

Card, Nequi and DaviPlata share one enrollment and settlement lifecycle. Executable-method
availability is a separate authenticated browser projection, not a mutable interpretation of Price
terms. DaviPlata's returned OTP URLs are not destination authority: both must exactly match an
operator-reviewed, environment-matching HTTPS policy prepared by Core, within the existing Wompi
origins. Missing or invalid policy disables the method, including Sandbox; Production additionally
requires explicit merchant recurring activation. Dashboard enablement and support-chat assertions
cannot substitute for provider protocol and browser CORS evidence.

DaviPlata document/product values, OTPs and rotated one-use service bearers stay in the mounted
browser authorization. The opaque challenge serializes actions, bounds attempts and lifetime, and
revokes on disposal or authentication loss. Approved tokens remain enclosed while submitting a
stable PaymentRequestId; explicit in-memory submission retry cannot repeat OTP or source creation.
Core independently verifies token approval and binds a one-way authorization digest to the atomic
live-authority claim before source creation. Source type and billing email must match the enrollment.
Authorization and source availability still do not activate paid Pro; matching verified asynchronous
BillingAttempt settlement does.

Wompi documents a once-per-merchant Production wallet subscription and no proven recovery after
losing an approved authorization before source creation. Reload therefore must not promise a safe
restart or durable resume. The single source per User is retained without method switching, and
method expansion uses a forward D1 migration that preserves all authorization and billing history.
The [Sandbox proof runbook](../operations/daviplata-sandbox-proof.md) distinguishes synthetic fixtures,
the opt-in real-provider check and unresolved browser/native/recovery release gates.
