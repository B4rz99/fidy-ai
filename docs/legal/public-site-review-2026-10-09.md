# Public-site legal copy review — 9 October 2026

## Review status

The Terms of Service are a proposal at `/terminos`, visibly marked as not in force and excluded
from indexing. Do not publish them as an active agreement until the operator's legal name, NIT,
notification address, telephone, effective date and legal review are complete. No acceptance
checkbox, authentication wording, subscription authority or historical consent record was changed.

The privacy revision documents existing behavior, rather than granting a new advertising or
marketing purpose. The original policy bytes are retained in
`history/policy-2026-09-28-cloudflare-providers.html`. The new policy is bound to its exact SHA-256
in the server's current disclosure. Existing launch-evidence records remain historical; do not
rewrite their reviewer/date or claim that they approve a newer policy. Reconfirm any applicable
operator release evidence before deployment.

## Source-backed additions

- Identity and providers: Google/Microsoft authentication and the distinction between contact
  email and independently verified mailbox access.
- Payment data: billing email and subscription metadata; payment credentials stay at Wompi.
- Browser storage: `__Host-fidy_session` has a 30-day Max-Age with renewal; `fidy-landing-theme`
  persists the chosen appearance; tab-scoped payment request IDs and billing email support
  recovery. The cookie policy does not promise that third-party infrastructure never sets cookies.
- Agents: explicit scopes, finite duration, data disclosure to the agent provider and separate
  revocation controls. Revocation neither recalls previously shared data nor reverses completed work.
- Retention: forwarded original emails have a 90-day limit; indefinite structural samples require
  anonymization and human approval. Existing Kapso retention limitations remain visible.
- Rights: access, corrections, deletion/revocation and Colombian response periods. No fabricated
  automatic account-deletion flow, advertising tracker, analytics provider or overseas legal regime.

Product evidence: `core/identity/contract.ts` (trial), `cloudflare/web-session/internal/credentials.ts`
(session cookie), `features/subscription/enrollment-gateway.ts` (tab storage),
`features/public-site/landing/theme.tsx` (appearance), the current Consent disclosure and
`docs/guides/hosted-mcp.md`. Paths without an application prefix are relative to their owning
server/web application.

## Reference review

Kebo's [terms](https://kebo.app/es/terms), [privacy](https://kebo.app/es/privacy-policy) and
[cookie policy](https://kebo.app/es/cookies-policy) were used only as a topic checklist. Fidy's
text is original. Blanket liability exclusions, US arbitration, marketing/pixel claims and
unrelated international privacy sections were not carried over.

The legal draft uses the Colombian [Consumer Statute, Law 1480 of 2011, as amended](https://www.cancilleria.gov.co/normograma/compilacion/docs/ley_1480_2011.htm)
and [Law 1581 of 2012](https://www.cancilleria.gov.co/normograma/compilacion/docs/ley_1581_2012.htm).
Relevant areas are provider identification and electronic-contract disclosure, non-waivable
consumer rights, applicable withdrawal/payment-reversal rules and personal-data request periods.
This review is not a legal opinion or a certification of compliance. An operational claims channel
must also provide the legally required tracking/evidence; an email address alone does not prove that.

## Deployment boundaries

The proposed edge rule exempts only GET/HEAD on explicitly listed public marketing/document paths
from browser-signature checks. It leaves managed WAF, DDoS, application authorization and other
paths unchanged. Its production effect requires an authorized deployment and fresh HTTP-reader
verification. The October 9 production MCP test is the owner's report, not a new independent
end-to-end test performed as part of this public-site change.
