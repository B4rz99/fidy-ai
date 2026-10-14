# Privacy and processing Consent

`/settings/privacy` lets a User inspect their saved authorization, withdraw processing Consent and
reach data-rights controls independently of ordinary product access. Withdrawal does not erase data,
cancel a Subscription or separately revoke credentials. Exact work durably admitted before withdrawal
may finish within its original lifetime; new protected work requires current Consent.

## Capability map

| Capability                                                                                       | Owner                                                                                | Verification                                                                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Read current Granted, Missing or Revoked standing                                                | `feature.tsx`; server `processing-consent` declaration and native Consent operations | Local Worker/D1; live Granted read                                                                |
| Explicit withdrawal, durable receipt and idempotent retry                                        | Confirmation checkbox and command in `feature.tsx`; private Core/User coordinator    | Built browser → public Ingress → Core/local D1; live withdrawal pending                           |
| Recover an uncertain withdrawal without automatic mutation replay                                | Explicit status reread resets confirmation                                           | Built-browser failure/retry check                                                                 |
| Inspect the exact saved disclosure, reference and acceptance instant, including after withdrawal | `authorization-copy.tsx`; `GET /web/consent/authorization`                           | Local UUID and provider-signup references; production failure reproduced, fix awaiting deployment |
| Browse saved effective Transactions after withdrawal without commercial access                   | Existing Transactions workspace; fresh cookie-only privacy transport                 | Built browser/Core/local D1; 101-record continuation and retry; live withdrawn-User read pending  |
| Reach rights contact and policy without an authorized session                                    | `RightsContact` in `feature.tsx`                                                     | Built-browser refused-session/mobile check; public production routes return 200                   |
| Refuse foreign, expired, revoked, malformed or bearer-only authority                             | Consent public/Core boundaries                                                       | Local negative and race/rollback tests; anonymous live reads return 401/no-store                  |

The browser derives its contract from `apps/server/src/shell/processing-consent/contract.ts`.
`apps/server/cloudflare/consent` owns native proof checks, evidence and withdrawal; public Ingress has
no D1 binding. Saved disclosure is inert text, not renewed processing authority. Evidence stays in
the authentication registry rather than browser persistence.

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

## Remaining live evidence

- Deploy the copy fix, then reread it using the current signed-in browser.
- On an explicitly designated test account, withdraw Consent, reload the original receipt, verify new
  protected work is refused, and open saved Transactions with a recent session. The current production
  account has not been withdrawn during this audit.
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
