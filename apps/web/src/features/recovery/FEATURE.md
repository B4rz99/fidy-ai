# Backup recovery code

Capability and verification map for the recovery section of `/settings/account`. Product requirements remain in GitHub issues.

## Behaviour

An explicit click opens a local review describing immediate invalidation and one-time disclosure.
Review and cancellation issue no request. Confirm synchronously closes admission before requesting
canonical backup-code rotation under the bound fresh WebSession; repeated callbacks from that review
cannot request another rotation. The server snapshots the current credential revision and guards its
replacement and metadata Audit in one native D1 batch. A concurrent credential change refuses the
stale request. Freshness remains separate: independent valid requests can rotate again without
consuming or extending the session's original freshness window.

The replacement remains redacted in private mounted state and reaches the raw-code presenter and
explicit clipboard action only during disclosure. Generic presentation state has no raw code.
Navigation, document departure and authentication replacement synchronously retire the task,
wipe its redacted code reference and fence late command and copy completions. The settings caller
mounts the feature without supplying transport callbacks or choosing a User. Sensitive clipboard
ownership retains matching cleanup and the ten-minute copy lifetime; disclosure has no separate
expiry timer. Failed clipboard writes do not report “Copiado”, and a late clipboard completion
cannot clear unrelated newer text.

A lost, malformed or unavailable rotation result is Uncertain rather than retry permission. It
reveals no code, does not claim that the preceding code remains valid and offers fresh sign-in.
The Uncertain task offers no repeat action. A private non-secret admission marker remains in the
existing authentication registry while a submitted result is unresolved or Uncertain. Leaving and
returning through same-document navigation cannot clear it. Only a definitive result delivered to
the live task clears that marker; authentication replacement or a new document's authoritative
session observation creates a fresh registry. Raw code never enters that registry. Fresh sign-in
leads to a new mounted task and explicit review; that later rotation is a new replacement, never
redisclosure or replay. Missing authentication and expired session freshness retain distinct sign-in
guidance.
The server continues to own fresh authority, proof replacement and retained security evidence.
Support refusal remains non-enumerating and does not invent a retained rejected case.

## Verification

The built-browser recovery journey uses isolated Users and the actual public/Core/D1 rotation,
with controlled transport loss or malformed responses only after a successful native commit. It
covers review/cancel admission, duplicate Confirm, uncertainty retained across same-document
navigation, fresh same-User sign-in,
mounted disclosure disposal, denied clipboard acknowledgement and late completions after departure
or owner replacement. Provider-authentication journeys retain fresh-session refusal and recovery
rotation through the same review step.

Sensitive clipboard tests exercise the existing external clipboard boundary, including copy expiry,
matching cleanup, silent permission refusal and pending completions after scope close. Native
browser-authentication and support-recovery tests preserve credential races, rollback, atomic Audit,
unchanged freshness, same-User pairing expiry and one-use backup proof consumption.

These isolated checks do not establish production credential replacement or live operator/provider
recovery. Never rotate a production User's recovery proof as a test fixture.

```sh
bun run --cwd apps/web test src/browser/clipboard.test.ts
BROWSER_COST_MEASUREMENT=1 bun run --cwd apps/web test:browser recovery-live-disclosure.spec.ts --workers=1 --timeout=120000
bun run --cwd apps/server test:cloudflare cloudflare/onboarding/browser-authentication.test.ts cloudflare/recovery/support-recovery.test.ts --maxWorkers=1
```
