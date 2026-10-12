# Verified email replacement

Broad non-AI audit, 2026-10-12, baseline `9aafe8db54`: the complete 449-check web suite and 99-check ordinary browser suite passed, including the real local public Core/D1 replacement journey. A further onboarding/PAT/OAuth Worker/D1 run passed 303 checks, including email replacement authority and resource bounds. The three opt-in browser-cost checks passed on synchronized trunk `6863b80f2a`; navigation and authentication cleanup used isolated local Users. No real mailbox was replaced, and synthetic delivery does not prove production email delivery or representative-load performance.

Capability and verification map for `/settings/email`. Product requirements remain in GitHub issues.

## Behaviour

An established verified EmailCredential can be replaced after fresh browser pairing. Provider sign-in with Google or Microsoft does not establish that separate credential. The old verified mailbox remains active until the new proof is accepted.

The mounted form accepts a candidate mailbox, requests a code, and shows the candidate while awaiting proof. Completion submits only the combined code through the canonical typed client. The proof field clears immediately on submission. Invalid proof retains the candidate and offers resend or another mailbox. Missing or stale authority directs the User to browser pairing. Transport or malformed responses report an uncertain result rather than successful replacement or invalid proof, and advise checking sign-in before another change.

Candidate mailbox and proof remain transient form/controller state. Neither enters navigation, browser storage, or shared query results. Server email authentication owns proof delivery, consumption, credential replacement and authority checks.

## Verification

Current-artifact regression, 2026-10-12, trunk baseline `9aafe8db54`: the real public Core/D1 browser replacement journey passed in 5.5 seconds using ordinary assertion deadlines. The test used an isolated verified-email User and synthetic external delivery, then verified completion and private proof disposal. The current focused React audit also passed the email controller/feature checks within its 54-check run; two replacement refusal/resource checks passed within the four-check Worker/D1 rerun. This establishes current local integration and refusal evidence, without replacing a production mailbox or proving real mail delivery under representative load.

On 2026-10-11, **10 rendered checks** passed across the feature and controller suites, covering pending/completed/invalid states and request/completion transport, malformed response and authority refusals.

The real built-browser replacement journey first timed out at the success assertion while displaying “Procesando…”. An isolated rerun with a 30-second assertion deadline passed in **8.2 seconds**, without application changes. It signed in through real Core, requested replacement through public operations, delivered a synthetic proof at the external-provider fixture, completed replacement, and verified the success display and absence of proof/browser storage. This proves the local workflow, not real provider delivery or production behaviour.

A further isolated rerun on 2026-10-11 from the merged Foldkit revision passed in **8.1 seconds** with the ordinary browser assertion deadlines and no application changes. This closes a missing ordinary-deadline repeat; representative-load and Production evidence remain separate.

Two actual Worker/D1 checks also passed for malformed replacement work, revoked/foreign sessions, and bounded proof delivery across rejected attempts.

Production replacement remains untested. Do not rotate the User's real mailbox as an audit fixture. Repeat timing checks under representative load before treating the earlier timeout as resolved performance evidence.

```sh
bun run --cwd apps/web test src/features/email-replacement
BROWSER_COST_MEASUREMENT=1 bun run --cwd apps/web test:browser 01-real-core-journeys.spec.ts --grep 'replaces a verified EmailCredential' --workers=1 --timeout=120000
```
