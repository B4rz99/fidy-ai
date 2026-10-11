# Hosted Agent chat

This is a capability and verification map for the authenticated floating chat, not a separate specification. Product requirements and fixes remain in GitHub issues.

## Behaviour and verification

| Capability         | Implemented behaviour                                                                                                                                                                              | Verification and limits                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation       | One User message followed by one assistant reply. A visible successful reply is acknowledged automatically; ordinary conversation has no receipt confirmation button or success footer.            | `application.test.tsx` exercises two consecutive replies and exact delivery requests. Live conversation was exercised before the latest deletion fix; repeat after deployment.                        |
| Lifetime           | Dismissal and navigation retain the draft and mounted conversation. Logout discards them. Visible history is bounded to 40 entries; the browser does not persist conversation state.               | Application tests exercise dismissal, navigation, closed replies and logout.                                                                                                                          |
| Visibility         | A reply received while closed is acknowledged only once it is visibly rendered in an open chat and visible document.                                                                               | Application tests plus `visible-reply.test.tsx`; these use controlled transport responses.                                                                                                            |
| Failure            | A failed proposal retains the draft, removes its temporary User entry and allows another submission. Processing or uncertain execution blocks a new submission until the retained Turn is checked. | Code in `controller.ts`; progress recovery has an application test. Two rendered regressions verify exact draft retention and duplicate-free explicit retry for generic failure and quota exhaustion. |
| Delivery recovery  | A failed delivery receipt retains the exact reply and receipt. An explicit connection retry resends the receipt, not the original message or mutation.                                             | Application test verifies identical receipt bodies and blocks submission until delivery succeeds.                                                                                                     |
| Transaction tools  | Hosted inference uses installed canonical operations; Transaction capture, correction, query and deletion retain their authority and Audit checks.                                                 | Core and actual local Worker/D1 tests, with deterministic inference. They do not prove live model decisions.                                                                                          |
| Dates              | A date without a time in Bogotá must resolve to local midnight, represented as 05:00 UTC.                                                                                                          | Hosted inference conformance rejects UTC midnight for that request. Live capture and correction previously displayed the intended local date; repeat on the deployed fix.                             |
| Sensitive mutation | Exact mutation confirmation is separate from automatic reply delivery. Deletion requires a challenge bound to the observed owned Transaction and is consumed once.                                 | Worker/D1 deletion confirmation regression. Live deletion is pending deployment.                                                                                                                      |
| Provider quota     | Recognized daily-allocation refusal returns safe quota-specific copy. The draft is retained, no reset time is promised and no automatic resubmission occurs.                                       | Production provider request on 2026-10-11 returned HTTP 429 with daily free allocation exhausted. Adapter and Worker/D1 regressions pass; production deployment and live verification remain pending. |

## Owners

- `program.ts` composes the chat window, messages, composer and recovery actions.
- `controller.ts` owns submission, bounded history, pending state and exact delivery receipts.
- `visible-reply.tsx` reports committed visible replies; presentation does not decide receipt transitions.
- Server HostedTurn owns admission, inference, canonical tool execution, confirmation and retained delivery evidence. Workers AI is a provider boundary, not browser authority.

## Evidence and remaining checks

On 2026-10-11 at revision `b131e61435ec63c57470f57ed1ad3409261f0005`, the combined Transactions/chat rendered feature suite passed 50 checks; `application.test.tsx` passed 24 checks; Transactions and hosted-session Core tests passed 33 checks. Counts include neighbouring capabilities and are not all chat tests.

The deterministic hosted inference suite passed 37 checks, including date-only conformance. The combined Transaction/HostedTurn actual local Worker/D1 suite passed 187 checks, including exact once-only deletion confirmation. The built-browser Transactions journeys passed 14 checks. Across these commands, 345 checks passed; no live model call was required.

The quota-feedback patch on release base `a2483f5dd1939fc3c3a37887c4e93c8081893666` passed all 27 current rendered chat/application checks. This includes two consecutive messages, delivery recovery, and exact failed-draft retention followed by explicit retry without duplicate messages. The expanded provider adapter suite passed 38 checks, including raw binding and REST quota formats and capacity refusal.

The deployment of [PR #1204](https://github.com/B4rz99/fidy-ai/pull/1204) remains blocked by live Workers AI conformance. Earlier runs reported `ProviderUnavailable`; a direct provider diagnostic confirmed exhausted daily free allocation. Quota classification merged in [PR #1213](https://github.com/B4rz99/fidy-ai/pull/1213), and the sanitized preflight diagnostic was corrected in [PR #1218](https://github.com/B4rz99/fidy-ai/pull/1218). The subsequent [production run](https://github.com/B4rz99/fidy-ai/actions/runs/38148906550) at `55f0e03e4afb22f11848f7f2b5bb7d8cc45a77fb` refused deployment with `check=canonical_query category=ProviderQuotaExceeded`. No successful deployment or completed production rerun is claimed.

Remaining checks:

- Rejected proposal/draft recovery now has two passing rendered regressions: generic unavailability and daily quota exhaustion. Explicit resubmission produces one User/assistant pair; no automatic replay occurs.
- Quota classification is implemented for bounded JSON HTTP 429 provider responses with documented code 3036 or production-observed code 4006. Capacity code 3040 remains generic transient unavailability. The adapter suite passed 38 tests and the actual Worker/D1 regression passed: the Turn is retained as failed, with no assistant reply or raw provider detail. Deployment remains pending.
- After deployment, run greeting, follow-up, owned Transaction query, date-only capture/correction, and exact deletion confirmation. Verify one User/assistant pair for each successful exchange.
- Verify read-after-delete, Transaction history and Dashboard totals exclude the deleted record while retained source and Audit evidence remain intact.
- Clean up only this chat's labelled production fixtures. The original `PRUEBA QA CHAT 20261010` has explicit deletion approval. Deletion approval for `PRUEBA QA FECHA CHAT 20261010` remains pending.

## Rerun

```sh
bun run --cwd apps/web test src/features/agent src/application.test.tsx
bun run --cwd apps/server test:core src/core/agent/hosted-agent-session.test.ts --coverage.enabled=false
bun run --cwd apps/server test:hosted-inference
bun run --cwd apps/server test:cloudflare cloudflare/agent/hosted-turn.test.ts --maxWorkers=1
```

Local deterministic inference and transport fixtures do not prove live Workers AI availability or production model behaviour. Record deployment revision and observed outcomes separately when resuming the production checklist.
