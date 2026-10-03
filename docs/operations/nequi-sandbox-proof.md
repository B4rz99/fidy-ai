# Nequi reusable-enrollment protocol proof

Issue: [#231](https://github.com/B4rz99/fidy-ai/issues/231).

## Status and launch boundary

The implementation has synthetic adapter, browser-lifetime and native D1 tests. **A successful real
Sandbox proof has not yet been recorded.** Existing Actions secrets establish configuration, not
merchant eligibility or reusable-source behavior. This document is not Production or onboarding
approval; remaining native-platform launch proofs belong to #920.

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

After a reviewed merge, dispatch `.github/workflows/nequi-sandbox.yml` through Actions. Record the
successful run link and revision here before claiming issue acceptance. No successful run is
currently linked.

## Provider references

- [Reusable payment sources](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)
- [Sandbox test data](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/)

These references motivate the requests; the real workflow must establish actual reusable Nequi
Sandbox behavior and eligibility. Source management/replacement and automatic-renewal execution
remain separate work.
