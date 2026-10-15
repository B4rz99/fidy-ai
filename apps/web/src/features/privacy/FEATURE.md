# Privacy and processing Consent

`/settings/privacy` lets a User inspect their saved authorization, withdraw processing Consent and
reach data-rights controls independently of ordinary product access. Withdrawal does not erase data,
cancel a Subscription or separately revoke credentials. Exact work durably admitted before withdrawal
may finish within its original lifetime; new protected work requires current Consent.

## Capability map

| Capability                                                                                       | Owner                                                                                | Verification                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Read current Granted, Missing or Revoked standing                                                | `feature.tsx`; server `processing-consent` declaration and native Consent operations | Local Worker/D1; live Granted and Revoked reads                                                    |
| Explicit withdrawal, durable receipt and idempotent retry                                        | Confirmation checkbox and command in `feature.tsx`; private Core/User coordinator    | Built browser → public Ingress → Core/local D1; live withdrawal and identical receipt after reload |
| Explicitly renew the saved disclosure after withdrawal                                           | `renewal.tsx`; fresh cookie-only `POST /web/consent/renew`                           | Built browser → public Ingress → Core/local D1; live renewal pending deployment                    |
| Recover an uncertain withdrawal without automatic mutation replay                                | Explicit status reread resets confirmation                                           | Built-browser failure/retry check                                                                  |
| Inspect the exact saved disclosure, reference and acceptance instant, including after withdrawal | `authorization-copy.tsx`; `GET /web/consent/authorization`                           | Local UUID and provider-signup references; live provider-signup copy read passed after deployment  |
| Browse saved effective Transactions after withdrawal without commercial access                   | Existing Transactions workspace; fresh cookie-only privacy transport                 | Built browser/Core/local D1; 101-record continuation and retry; live empty-account read passed     |
| Reach rights contact and policy without an authorized session                                    | `RightsContact` in `feature.tsx`                                                     | Built-browser refused-session/mobile check; public production routes return 200                    |
| Refuse foreign, expired, revoked, malformed or bearer-only authority                             | Consent public/Core boundaries                                                       | Local negative and race/rollback tests; anonymous live reads return 401/no-store                   |

The browser derives its contract from `apps/server/src/shell/processing-consent/contract.ts`.
`apps/server/cloudflare/consent` owns native proof checks, evidence and withdrawal; public Ingress has
no D1 binding. Saved disclosure is inert text, not renewed processing authority. Evidence stays in
the authentication registry rather than browser persistence.

## Whole-User erasure — #1274

`erasure-request.tsx` records one fresh-cookie, explicit confirmation for the same User through the
server-declared `processingConsent.erase` endpoint. It displays review pending, never completed
deletion. Reload and explicit retry reuse the same server intention; no erasure UUID, provider
reference, raw error or operator controls are shown. Support remains accessible without login.
The existing register/handoff, dedicated operator Access, current owner inventory and resumable
D1/R2/User-coordinator disposition are described in
[the erasure procedure](../../../../../docs/operations/titular-erasure-1274.md).

The production-built local browser test exercises real public ingress/Core/D1, confirms disabled
submission until explicit choice, records HTTP 202, refuses a false deletion claim and verifies the
identical response on retry. This is local evidence; no Production erasure was performed.

## Evidence — 2026-10-14

- All 53 Consent/onboarding Worker tests passed against isolated local D1. They include two-User
  isolation, hostile Origin, expired/raced sessions, rollback, bounded saved disclosure, malformed
  onboarding references and exact authorization readback after withdrawal.
- Four production-build browser journeys passed: expired-trial withdrawal and receipt reload,
  authorization-copy failure/retry, uncertain withdrawal with explicit status recovery, refused-session
  contact/navigation, mobile layout and read-only Transaction pagination. External delivery is controlled;
  the persisted withdrawal/history journey uses real local Workers and D1.
- The unfiltered Core gate passed all 421 tests with its normal coverage thresholds. This does not
  establish live completion of every queued owner after withdrawal.
- Production status loads for the signed-in User and withdrawal starts disabled. Anonymous status
  and copy reads return 401 with `no-store`; a caller-selected `userId` query is refused with 400.
  The policy and Privacy routes return 200.
- Production “Consultar prueba” returned 503. A regression reproduced it with a real provider-signup
  grant: the response incorrectly required a UUID instead of the existing onboarding-reference union.
  The fix accepts the owner's UUID or 43-character reference while keeping malformed references refused.
  A read-only aggregate confirmed both formats in production (one UUID, four opaque references;
  ten rows read, zero written). No personal record content was retrieved.
- The fix shipped in PR #1318. Production deployment run 38658380132 passed promotion and
  post-promotion checks. The signed-in browser then loaded the saved provider-signup authorization
  with its reference, acceptance date and disclosure version; the copy endpoint returned 200.
- With the owner's explicit designation of the signed-in account, Production withdrawal succeeded.
  Reload returned the identical receipt and acceptance-copy retrieval still returned 200 afterward.
  The older sign-in could not read privacy Transactions (401). Returning-user Google sign-in refreshed
  identity without granting Consent: the same withdrawal receipt remained, privacy Transactions returned
  200, and the workspace showed “Solo lectura” without registration or bulk-edit controls. This account
  has no Transactions; populated details and continuation are local evidence, not live evidence.
  Ordinary Dashboard access was refused (401) even with the fresh sign-in. No data was erased.
- That Dashboard refusal exposed misleading “Sesión vencida” copy. A built-browser/Core/local D1
  regression reproduced it. The shared refusal screen now avoids guessing the cause and links back to
  Privacy or sign-in; the regression checks return to the identical receipt after the refusal.

## Remaining live evidence

- Renewal is implemented locally: the exact withdrawal, authorization reference and disclosure hash
  bind fresh browser acceptance. Immutable withdrawal history and new acceptance commit with Audit
  before removing the current cutoff. Retry returns the same receipt; a later withdrawal cannot be
  cleared by the earlier request. TrialPeriod and independent credential/category revocations stay intact.
- Local renewal evidence includes refusal of altered/cross-User proof, freshness lost before commit,
  rollback on ignored Audit or cutoff removal, and append-only legal history. Five built-browser
  Privacy journeys passed, including renewal, reload and access to Upgrade.
- Live renewal passed on 2026-10-15 at revision `4dfc547ab40e47b50c00fde800d3236fe550239f`
  after [deployment recovery and release](https://github.com/B4rz99/fidy-ai/actions/runs/38815398101).
  Returning login preserved the same withdrawal receipt. Explicit renewal for the approved QA
  account returned active authorization and remained active after reload. Before renewal, Upgrade
  correctly explained withdrawn authorization; afterward it allowed Sandbox enrollment. The approved
  synthetic weekly payment then created a persisted paid period. Cancellation is tracked by
  the [Subscription feature](../../../../server/src/core/subscription/FEATURE.md).

- Live completion of exact pre-withdrawal queued work, independent category opt-outs and provider
  delivery need their native owner fixtures. Category-specific WhatsApp opt-ins are separate from
  this processing withdrawal surface.
- A real Titular access/correction/erasure request requires the operator procedure and scoped delivery
  evidence. The local case-register/browser exercise is not live erasure or legal approval. See
  [withdrawal scope](../../../../../docs/operations/processing-withdrawal-1273.md) and
  [operator procedure](../../../../../docs/operations/titular-requests-1273.md).

## Rerun

```sh
bun run --cwd apps/server test:cloudflare cloudflare/consent cloudflare/onboarding/consent-ingress.test.ts
bun run --cwd apps/web test:browser privacy.spec.ts --workers=1
bun run --cwd apps/server test:core
```
