# Bounded browser and ingestion security assessment

Issue [#1263](https://github.com/B4rz99/fidy-ai/issues/1263). On 2026-10-20, the owner authorized
extending synthetic adversarial coverage through ingestion and hosted execution, alongside a
browser security assessment. This assessment uses local isolated stores and synthetic identities;
it performs no production writes, external messaging or paid model calls.

## Executed coverage

The browser harness builds the production-mode web artifact and runs real public/Core Workers
with isolated native D1. External approval, proof delivery and payment-provider responses remain
fixtures. All browser tests ran with one worker and no retries.

| Boundary                  | Observed result                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account switching         | A stale tab cannot submit its prior draft or log out the new session; broadcast retires the old view.                                                                                                                                                                                                                           |
| User isolation            | Another User's Transaction cannot be fetched or displayed through public routes.                                                                                                                                                                                                                                                |
| Login and recovery        | Real pairing redemption and SupportRecoveryCase approval work; rotated recovery material stays within its mounted disclosure view. Pairing expiry and slowdown are also tested, with presentation fixtures where declared by those cases.                                                                                       |
| OAuth                     | Explicit review and cancellation, code exchange, forged-session/callback refusal, bounded registration/discovery and safe unavailable/revocation presentation pass. Malicious client metadata renders as text.                                                                                                                  |
| Stored content            | HTML-shaped Counterparty text saved through the real API remains literal after browser reload; no injected image node or JavaScript marker appears.                                                                                                                                                                             |
| CSV/XLSX ingestion → host | Real WhatsApp document admission, native staging/publication, processing/replay, recovered delivery and hosted history read carry hostile text as data. Forced model deletion requests, directly and in a batch, stop at exact-action confirmation; the Memory stays intact. Another User's hosted query returns empty history. |
| Email                     | A conflicting MIME recipient and forged instructions cannot change the envelope-resolved User. Unsupported instructions remain one review item on replay, creating no Transaction or SourceAttestation.                                                                                                                         |
| Image caption             | Forged identity and approval text stays private pending evidence. Foreign-User admission fails, replay does not recharge, and no extraction is claimed.                                                                                                                                                                         |
| Existing host regressions | Signed voice, hostile Memory/Transcript/tool results, absent toolkit operations, confirmation/replay, limits and hosted statement recovery remain covered by the existing suites.                                                                                                                                               |

Results: **122 server integration tests passed across six files** and **26 browser tests passed**
(one admission case, 24 existing journeys and one new stored-content case). Eight new test cases
were added: four statement/host variants, two email cases, one image-caption case and one browser
stored-content case. Development assertions initially used an incorrect tool-result field and an
over-specific email review reason; correcting those test expectations required no production fix.
No new exploitable vulnerability was reproduced in these scenarios.

## Reproduction

Use the repository's reviewed Bun runtime. Server paths are relative to `apps/server`; browser paths
are relative to `apps/web`. Check ownership of loopback ports 4173–4175 before browser execution.

```sh
bun run --cwd apps/server test:cloudflare cloudflare/agent/hosted-ingestion-security.test.ts cloudflare/agent/hosted-tool-turn.test.ts cloudflare/agent/hosted-turn.test.ts cloudflare/agent/hosted-statement-turn.test.ts cloudflare/ingestion/media-submissions.test.ts cloudflare/ingestion/forwarded-email.test.ts --maxWorkers=1
bun run --cwd apps/web test:browser e2e/session-binding.spec.ts --project=admission --workers=1
bun run --cwd apps/web test:browser e2e/session-binding.spec.ts e2e/oauth-review.spec.ts e2e/browser-pairing.spec.ts e2e/recovery-live-disclosure.spec.ts e2e/01-real-core-journeys.spec.ts --project=browser --no-deps --workers=1
```

The final browser command includes the added stored-content case; the recorded execution ran that
case separately after the 24 existing journeys. There is no hidden dependency on a live provider.

## Limits and separate decisions

This is an AI-assisted bounded assessment, not an independent penetration test, full ASVS assessment
or launch approval. WhatsApp subject admission runs against the retained synthetic identity; media
download and delivery use controlled provider responses. The new statement path does not establish
public webhook signature verification or live media transport. Existing signed-voice coverage crosses
the signature boundary separately. Provider responses deliberately force a malicious model proposal to test host
enforcement; passing is not evidence that the live model would refuse every injection.

Image OCR, audio transcription accuracy, PDF extraction, provider configuration, complete WebSession
expiry behavior and packaged CLI checks across supported operating systems are not newly verified
here. The live 125-sample model evaluation retains its own evidence and request accounting.
No prompt, model, authorization or MCP confirmation policy changed in this assessment.

MCP's accepted client-asserted confirmation risk remains: valid client acceptance does not attest
human presence. Independent Fidy browser approval for selected destructive operations is a product
and authority-contract decision, not a fix silently included in these tests. Operational detection
and fallback gaps remain tracked separately in [#1262](https://github.com/B4rz99/fidy-ai/issues/1262).
