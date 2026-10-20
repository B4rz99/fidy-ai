# Nequi reusable-enrollment protocol proof

Issue: [#231](https://github.com/B4rz99/fidy-ai/issues/231).

## Status and launch boundary

**Real Sandbox protocol proof passed:** [Actions run 38672345124](https://github.com/B4rz99/fidy-ai/actions/runs/38672345124),
revision `20889fa3d90d8f86c09ddce0cc790c8bb6ac761c`, completed 2026-10-14 at 21:49 Bogotá.
All four selected cases executed: weekly, monthly and yearly approved first payments, and a
declined weekly first payment. Each approved case verified the reusable NEQUI source and matching
settlement. The declined case reached the bounded failure decision without granting paid access.
The other 67 cases in that test file were excluded by the workflow's test-name filter.

The [2026-10-18 rerun](https://github.com/B4rz99/fidy-ai/actions/runs/39155516916) passed the same
four scenarios at `1195aeb38737c77e9ed6e360d98f140b1bb8b2f9` with Effect 4.0.3; the other 76 cases
were excluded. This remains real Sandbox provider plus local D1/activity evidence, not deployed
wallet, callback or Queue/Workflow verification.

The implementation also has synthetic adapter, browser-lifetime and native D1 tests. This result
does not establish Production merchant eligibility, deployed callback delivery, automatic renewal
or native Queue/Workflow recovery. Remaining native-platform launch proofs belong to #920.

The manual `Nequi Sandbox protocol proof` workflow runs only a reviewed `trunk` revision, under the
existing protected `production` environment that holds the Wompi Sandbox secrets. It has no
Cloudflare deployment credentials and rejects a non-Sandbox provider environment before HTTP.
Do not download credentials, add them to local files, enable HTTP tracing, or retain response bodies.

## Proof and limits

The opt-in cases in `apps/server/cloudflare/subscription/payment-enrollment.test.ts` use the closed
outbound adapter with Wompi's documented synthetic Sandbox numbers. They independently verify token
approval and matching `AVAILABLE` `NEQUI` source identity, then run the existing BillingAttempt
collection/settlement path against real Sandbox transactions. Weekly, monthly and yearly first
payments must succeed; the declined weekly case must reach the existing bounded failure decision.
Token approval and source creation alone do not pass the proof.

The D1 and activity runner are local native test harnesses. This is provider-protocol evidence, not
Queue/Workflow deployment, restart, webhook-delivery or Production merchant evidence. Live provider
identities, numbers, tokens, acceptance JWTs and raw bodies are not emitted as fixtures or artifacts.
The job summary records only revision, completed scenarios and this evidence scope. Synthetic
fixtures in unit tests must not be described as observed provider responses.

Approval polls and settlement lookups are bounded, and ambiguous source/transaction POSTs are never
replayed. Any unsupported tokenization, unavailable source, ambiguous creation or unmatched/late
payment fails the proof. Do not change the expected outcome or retry a financial POST to get a green
run. Investigate merchant support and provider semantics before treating the feature as launch-ready.

For a rerun after reviewed changes, dispatch `.github/workflows/nequi-sandbox.yml` on `trunk`
through Actions and record its successful run link and revision here. The linked evidence above
establishes only the four selected Sandbox protocol scenarios.

## Provider references

- [Reusable payment sources](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)
- [Sandbox test data](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/)

These references motivate the requests; the linked run establishes the selected reusable Nequi
Sandbox scenarios. Source management/replacement and automatic-renewal execution remain separate
work.
