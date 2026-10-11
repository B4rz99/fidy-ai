# Backup recovery code

Capability and verification map for `/settings/recovery`. Product requirements remain in GitHub issues.

## Behaviour

An explicit click requests canonical backup-code rotation under a fresh WebSession. Rotation invalidates the preceding code immediately. The raw replacement is disclosed in one mounted view, with an explicit copy action. Disposing the authenticated Foldkit mount drops that disclosure; sensitive clipboard ownership handles clearing. Failed clipboard writes do not report “Copiado”.

The private recovery controller serializes canonical rotation and consumes its response inside the mounted lifetime. The raw code stays outside the Foldkit Model and shared Atom results. A stale session requests new sign-in. Other failures disclose no code and offer another rotation; only the latest visibly disclosed code should be used. The server owns fresh authority, proof replacement and retained security evidence.

## Verification

On 2026-10-11, **3 rendered checks** passed: mounted disclosure disposal, denied clipboard feedback, and safe retry after failed rotation. These use controlled callbacks; they do not prove real credential rotation or recovery login.

Both actual Worker/D1 fresh-session rotation and expired-freshness refusal passed on 2026-10-11 in the focused onboarding suite. The same run also passed two email replacement refusal/resource checks (**4 passed, 16 skipped** total). These are local isolated persistence and authority tests. Production rotation and recovery login remain untested. Use isolated credentials for these checks; rotating the User's production recovery proof would change their real access.

A real built-browser journey also passed (**1 check**, 12 seconds): fresh verified-email pairing for the isolated recovery User, canonical rotation, valid code disclosure, explicit copy affordance, and removal after navigation and remount with no browser storage. No HTTP routes were intercepted. The initial attempt used the ordinary financial fixture, which has no recovery credential, and received an authentication refusal; switching to the dedicated recovery fixture corrected the test setup without application changes.

The final regression uses a separately seeded disclosure User and proof so it cannot rotate the credential used by the existing recovery sign-in journey. It passed alongside that journey and Dashboard customization with two browser workers (**3 checks**), using actual isolated Core/D1.

```sh
bun run --cwd apps/web test src/features/recovery
BROWSER_COST_MEASUREMENT=1 bun run --cwd apps/web test:browser recovery-live-disclosure.spec.ts --workers=1 --timeout=120000
bun run --cwd apps/server test:cloudflare cloudflare/onboarding/browser-authentication.test.ts --maxWorkers=1 --testNamePattern='rotates the backup recovery|refuses recovery rotation'
```
