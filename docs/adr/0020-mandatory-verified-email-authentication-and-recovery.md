# Google/Microsoft authentication, shared onboarding, and backup recovery

- **Status:** Accepted
- **Date:** 2026-08-23
- **Amended:** 2026-10-07
- **Implementation issue:** [Complete signup and browser login](https://github.com/B4rz99/fidy-ai/issues/1086)
- **Historical implementation:** [Verified email authentication and backup recovery](https://github.com/B4rz99/fidy-ai/issues/14)
- **Amends:** [ADR 0015](./0015-browser-paired-web-authentication.md) for provider approval and [ADR 0011](./0011-bsuid-authority-for-whatsapp-identity.md) for explicit initial association of an existing User; their session ownership and BSUID authority remain.

## Context

Mandatory mailbox codes add enrollment, delivery, resend, expiry, and uncertain-outcome handling to
signup and login. Visitors should use the same Google/Microsoft authentication from the public
website or a WhatsApp-led handoff. `UserId` must remain independent of providers and channels.
Provider sign-in proves provider-account control, not universal control of a returned email address.

## Decision

Google and Microsoft OpenID Connect (OIDC) authentication is sufficient for signup and ordinary
provider login. Both entry points share one provider-authentication and onboarding implementation.
Web signup requires no WhatsAppIdentity. WhatsApp signup accepts the current Fidy Consent disclosure
and opens a first-party provider-signup page instead of collecting an email and delivering a Fidy
verification code. Web signup also requires the current Consent disclosure. Neither journey requires
a Fidy mailbox code. Signup therefore requires a supported Google or Microsoft account.

A User is created with an established ProviderCredential, accepted Consent evidence, TrialPeriod,
and recovery credential in one atomic unit. WhatsApp-led signup also establishes WhatsAppIdentity
in that unit only after both sides of the association have been proven. ProviderCredential binds
validated issuer and subject to one stable UserId; email, display name, and phone are never its
identity key. Validate the provider response, intended audience, expiry, and browser-bound attempt
before using it. Request authentication scopes only, not mailbox-reading access.

Returned email is contact information, not automatically a VerifiedEmailCredential or authority for
email-code login, recovery, User merging, or channel association. Google can be authoritative for
Gmail and qualifying Workspace mailboxes; third-party Google addresses and Microsoft's general email
claim do not supply the same guarantee. Missing or changed email claims do not change an established
ProviderCredential's UserId. Removing the mandatory VerifiedEmailCredential is intentional, not a
claim that every provider address has independently verified mailbox control.

An opened or forwarded WhatsApp signup link never authorizes association. Completion requires the
provider-authenticated browser and explicit confirmation from the authenticated originating
WhatsApp caller, bound to the exact short-lived attempt and reviewed association. If the provider
credential already belongs to a User, preserve that User and require explicit linking; never create
a duplicate or silently associate by matching email. This permits initial association of an existing
web-created User, not replacement or reassociation of an established WhatsAppIdentity. BSUID authority
and the refusal of phone-based association remain unchanged.

Browser Login remains the only module that creates a WebSession. Provider authentication approves
the initiating browser-bound pairing for the established User; the independent browser-private
verifier remains necessary for redemption. Signup may continue into that separate login step without
another manual approval screen. Existing WhatsApp approval and SupportRecoveryCase approval remain
available. Provider callbacks do not mint a parallel session. Authentication remains available after
explicit Consent revocation to reach Fidy-owned re-consent and data-rights surfaces, while ordinary
canonical work remains blocked.

Provider tokens, browser verifiers, and recovery secrets never enter chat, Transcript, model context,
telemetry, or recoverable browser storage. Public handoff references grant no completion or session
authority. Any protocol-required authorization code is confined to the exact validated provider
callback, consumed once, and excluded from logging, referrers, and subsequent navigation; it is not
a Fidy magic link or session bearer. Callback and handoff replay, expiry, cancellation, and uncertain
outcomes must fail safely without duplicate creation or blind mutation retries.

Recovery owns BackupRecoveryCode digests and SupportRecoveryCases. Onboarding discloses one code once
on the first-party surface. When provider access and any established WhatsApp authority are lost,
an authenticated operator CLI can use that code and a tracked metadata-only case to approve an
existing BrowserLoginPairing. Approval consumes the code. Loss of every established proof ends recovery;
support never infers ownership from contact details, documents, or financial facts. Recovery's proof
consumption, evidence, case closure, and Browser Login's pairing binding remain one atomic coordination
unit; Browser Login alone issues the subsequent session. Fresh-session recovery-code rotation remains.

## Consequences

Issue #1086 must replace the superseded onboarding email-code path and align owner contracts, database
guards, Consent evidence, browser surfaces, security standards, and architecture documents. Resend's
unrelated delivery responsibilities are unaffected. Provider signup/login and explicit initial WhatsApp association are implemented locally; #1093
removes the earlier mailbox-code signup runtime. This is not Production-verified behavior.
No backward-compatibility requirement applies to this unreleased product.

Microsoft personal and work/school accounts from public-cloud Entra tenants are supported. Credential-management scope beyond the required explicit
linking must not be invented as part of signup.

## Rejected alternatives

- **Mandatory Fidy mailbox codes after provider sign-in:** rejected as redundant authentication
  friction under the accepted provider-credential model, not because all email claims prove mailbox control.
- **Automatic email matching or WhatsApp linking:** rejected because contact claims and forwarded
  handoffs cannot prove authority to merge Users or attach a channel.
- **Passwords, Fidy magic links, or provider-specific sessions:** rejected because they introduce
  additional credential or session lifecycles instead of reusing Browser Login.
- **Phone fallback, automatic WhatsApp reassociation, or document-based recovery:** rejected because
  these do not establish authority for the existing stable User.

## References

- [Google ID-token verification and authoritative mailbox claims](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Microsoft ID-token claims and email limitations](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)

## Implementation status after #1091

The [amended decision in #1086](https://github.com/B4rz99/fidy-ai/issues/1086) supersedes the
mandatory mailbox-enrollment decision: Google/Microsoft provider authentication now establishes
the signup/login credential; no VerifiedEmailCredential or Fidy mailbox code is required.
Explicit proof from both the provider-authenticated browser and originating WhatsApp caller
permits initial association of a web-created User, preserving its stable UserId.

#1088 establishes shared atomic Onboarding; #1089 and #1090 install Google and Microsoft web signup/login.
#1091 installs the WhatsApp provider handoff and explicit initial channel association. The originating
caller accepts the current chat disclosure, opens a ten-minute first-party provider link, and requests
“Estado” after provider authentication. Fidy sends the provider account and a public association identifier
matching the browser. Only an explicit confirm/deny reply to that exact review message from the original
Business Portfolio/BSUID and business phone endpoint settles the association. Confirmation and browser
proof are rechecked and consumed together in D1; an existing User receives only an initial association.
Native send claims and admission fence uncertainty; no blind resend or recovery redisclosure occurs.
Microsoft eligibility is resolved: personal and work/school accounts from public-cloud Entra tenants.
Real authenticated Worker/D1 and built-browser journeys are local evidence. Deployed Google/Microsoft
callbacks and real WhatsApp delivery/confirmation remain prelaunch checks. Legacy mailbox-code signup adapters are deleted in #1093, with no compatibility path. Both provider
browser journeys prove backup recovery and rotation without WhatsApp or mailbox authority; the
authenticated operator CLI and its deployed evidence remain tracked in #1092.
See the [authentication feature map](../operations/authentication-feature-map.md) for current local
evidence and remaining prelaunch checks.
