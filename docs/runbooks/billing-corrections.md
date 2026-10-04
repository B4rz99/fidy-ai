# Billing corrections (Sandbox)

Implements the development slice of [#225](https://github.com/B4rz99/fidy-ai/issues/225)
under ADR 0026. This is **not production refund approval**. No production correction can be
accepted or executed by this implementation, even if the operator has refund permission.

## Enable protected Sandbox support

- Apply `0035_billing_corrections.sql` through the normal private-Core D1 migration process.
- Use `WOMPI_ENVIRONMENT=sandbox` and the merchant's `prv_test_…` private key.
- Configure a **separate Cloudflare Access application** for
  `/internal/support/billing-refunds` and its read subpaths. Its allow policy grants refund permission
  only to authorized human support operators. Configure its audience as `BILLING_SUPPORT_AUDIENCE`.
- The team issuer is `CLOUDFLARE_ACCESS_ISSUER`. The refund audience must differ from the existing
  `CLOUDFLARE_ACCESS_AUDIENCE` used for support recovery. Missing or shared audiences fail closed.
- Access must protect the public support paths. Core independently verifies the assertion signature,
  issuer, audience, expiry and attributable human subject. Service-token assertions are refused.
- The public Worker forwards only the assertion and content type. Browser cookies, PATs, hosted agents
  and MCP do not grant refund authority. Do not add this mutation to the canonical operation catalog.

The Alchemy composition binds `BillingRefundWorkflowV1` and reuses the private billing Queue.
Scheduled dispatch recovers an accepted intent even when no immediate publication happens.
Configuring the support audience grants permission; it does not bypass the Sandbox-only money gate.
No deployment or merchant mutation is needed for the synthetic test suite.

## Initiate and observe

`POST /internal/support/billing-refunds`, with `Content-Type: application/json` and a valid
`Cf-Access-Jwt-Assertion` for the refund application:

```json
{
  "userId": "10000000-0000-4000-8000-000000000001",
  "billingAttemptId": "40000000-0000-4000-8000-000000000001",
  "requestId": "50000000-0000-4000-8000-000000000001",
  "intent": { "kind": "refund", "money": { "amount": "4000", "currency": "COP" } },
  "reason": "user-request"
}
```

Other reasons are `duplicate-collection` and `service-error`. For a whole card-transaction void,
replace the intent with `{ "kind": "card-void" }`; Fidy derives its exact Money from the original
charge. This never disables a payment source.

Acceptance returns HTTP 202 with a pending RefundAttempt, before any provider mutation. Keep the
same request identity for transport retries. Identical canonical input returns the existing attempt;
changed Money, kind, reason or BillingAttempt conflicts. Never issue a new identity to work around
an uncertain submission.

Read with `GET /internal/support/billing-refunds/{userId}/{refundAttemptId}` under the same permission.
Views expose Fidy identities, Money, reason, policy, lifecycle and UTC times, not provider ids,
payment-source details, private keys, assertions or arbitrary support notes.

## Lifecycle and policy

| Observation                                                     | Correction                | Access and renewals                                                    |
| --------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| Accepted, not submitted                                         | Pending / queued          | Unchanged; Money reserved                                              |
| Claimed, verification in progress                               | Pending / verifying       | Unchanged; Money reserved                                              |
| Lost response, ERROR, PENDING, malformed or uncorrelated result | Pending / outcome-unknown | Unchanged; reservation retained                                        |
| Correlated documented Sandbox DECLINED or CANCELLED             | Failed                    | Unchanged; reservation released                                        |
| Correlated APPROVED refund or verified VOIDED card transaction  | Succeeded                 | End this paid period's access at verification and stop future renewals |

The policy is `refund-ends-paid-period-v1`. Both full and partial refunds end the refunded period's
paid-Pro access immediately on verified success. The whole-card-void correction uses the same
consequence provisionally in Sandbox; its production access/renewal policy still needs explicit
confirmation. There is no automatic proration: support chooses positive exact Money explicitly.
Newer unrelated paid periods and an independently active original TrialPeriod still grant access.
Original successful BillingAttempts, Price snapshots and purchased-period intervals remain unchanged.
Historical attempt views retain their original period end; current standing and protected Pro checks
use the separate access adjustment. Renewal stops remove due intents and prevent late charge
settlement from recreating them. A future automatic-renewal implementation must honor these stops;
re-enrollment/restarting renewals is not implemented here.

Available Money is collected Money minus successful corrections and pending reservations. The D1
insertion guard enforces this atomically, including concurrent support requests. A User can have at
most four pending corrections and twelve accepted corrections per hour. Replays retain the original
operator evidence. Multiple approved provider transactions under one BillingAttempt fail closed;
they need an explicit Fidy-owned charge selector before they can be corrected safely.

## Ambiguous submissions and reconciliation

A durable submission claim is inserted before a provider POST. It is never deleted or rearmed.
Queue redelivery, Workflow restart and expiration of Workflow history cannot authorize another POST.
Unknown Refund V2 outcomes remain reserved and require provider investigation. Do not delete a
claim, mark an attempt failed from a timeout, infer no money returned from ERROR/PENDING, or mutate
original collection evidence to force standing.

Card voids can be verified through the documented `GET /v1/transactions/{id}`. Cron publishes bounded,
versioned read-only verification work, up to eight lookup attempts with a cooldown. A verification
message requires an existing submission claim and cannot initiate a mutation. Exhausting lookups
leaves the attempt pending; it does not establish failure. Pending corrections are included in the
private operational billing-work observation. Inspect Workflow/platform failures as well as support
views when a submission remains verifying.

Refund V2 lookup/listing, `Idempotency-Key`, refund event signatures, lost-response reconciliation,
merchant eligibility and method restrictions are **not established** by the contradictory support
replies. This implementation does not rely on them, send a presumed idempotency header, or install a
refund webhook. A known refund provider reference is retained only after correlated final evidence.
If a response or settlement write is lost, do not fabricate that evidence from an unsigned callback
or a screenshot. Extend the adapter with the confirmed lookup contract before resolving such refunds.

The verified Sandbox request/response contract is from
[Wompi Refund V2 Sandbox](https://docs.wompi.co/docs/colombia/reembolsos-sandbox/): private-key
`POST /v1/refunds`, exact minor-unit amount, transaction id and echoed custom reference. APPROVED,
DECLINED and CANCELLED can settle a matching deterministic Sandbox response; ERROR cannot prove
no funds moved. Card void and transaction lookup are documented in
[Wompi transactions](https://docs.wompi.co/docs/colombia/transacciones/).

## Before production

Production acceptance currently returns `unsupported` before a reservation or Wompi call. The
outbound correction operations are themselves Sandbox-only, and Workflow execution also checks
both the captured charge environment and the current Sandbox private-key configuration.

Before changing those gates, obtain written merchant-specific provider confirmation and approved
accounting treatment from the accountant. Replace `accounting: { kind: "sandbox-only" }` with the
approved invoice/credit-note lineage, gross/base/tax allocation and rounding treatment; implement
its independent operational lifecycle. Provider success must never imply credit-note issuance.
Add verified asynchronous refund lookup/webhook reconciliation and the required negative tests.
Any real-money proof still requires explicit user approval. Keep #225's external acceptance criteria
open until those determinations and production proofs exist.
