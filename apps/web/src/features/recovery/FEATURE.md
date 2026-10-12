# Backup recovery code

Broad non-AI audit, 2026-10-12, baseline `9aafe8db54`: the full 449-check web suite and 99-check ordinary browser suite passed, including the dedicated real local Core/D1 disclosure journey and recovery sign-in journeys. The further onboarding/PAT/OAuth Worker/D1 run passed 303 checks, with rotation and refusal coverage. These aggregate counts include adjacent features. No production recovery proof was rotated; physical provider recovery and production credential replacement remain deferred rather than treated as local passes.

Capability and verification map for `/settings/recovery`. Product requirements remain in GitHub issues.

## Behaviour

An explicit click requests canonical backup-code rotation under a fresh WebSession. Rotation invalidates the preceding code immediately. The raw replacement is disclosed in one mounted view, with an explicit copy action. A changed React identity drops that disclosure; sensitive clipboard ownership handles clearing. Failed clipboard writes do not report “Copiado”.

The canonical command is serialized and consumes the response through a terminal callback rather than retaining its raw code in shared Atom results. A stale session requests new sign-in. Other failures disclose no code and offer another rotation; only the latest visibly disclosed code should be used. The server owns fresh authority, proof replacement and retained security evidence.

## Verification

Current regression, 2026-10-12, trunk baseline `9aafe8db54`: the isolated Core/D1 disclosure journey passed again alongside four Accesos checks (five browser checks total, 12 seconds). Rotation disclosed a valid code, navigation and remount removed it, and browser storage remained empty. This did not rotate a production User's recovery proof or establish production recovery login.

The focused actual Worker/D1 onboarding rerun also passed four checks (16 unrelated checks skipped, 2.22 seconds), covering recovery rotation, expired-freshness refusal and email-replacement refusal/resource behaviour. No production recovery or email credential was changed.

On 2026-10-11, **3 rendered checks** passed: mounted disclosure disposal, denied clipboard feedback, and safe retry after failed rotation. These use controlled callbacks; they do not prove real credential rotation or recovery login.

Both actual Worker/D1 fresh-session rotation and expired-freshness refusal passed on 2026-10-11 in the focused onboarding suite. The same run also passed two email replacement refusal/resource checks (**4 passed, 16 skipped** total). These are local isolated persistence and authority tests. Production rotation and recovery login remain untested. Use isolated credentials for these checks; rotating the User's production recovery proof would change their real access.

A real built-browser journey also passed (**1 check**, 12 seconds): fresh verified-email pairing for the isolated recovery User, canonical rotation, valid code disclosure, explicit copy affordance, and removal after navigation and remount with no browser storage. No HTTP routes were intercepted. The initial attempt used the ordinary financial fixture, which has no recovery credential, and received an authentication refusal; switching to the dedicated recovery fixture corrected the test setup without application changes.

The final regression uses a separately seeded disclosure User and proof so it cannot rotate the credential used by the existing recovery sign-in journey. It passed alongside that journey and Dashboard customization with two browser workers (**3 checks**), using actual isolated Core/D1.

```sh
bun run --cwd apps/web test src/features/recovery
BROWSER_COST_MEASUREMENT=1 bun run --cwd apps/web test:browser recovery-live-disclosure.spec.ts --workers=1 --timeout=120000
bun run --cwd apps/server test:cloudflare cloudflare/onboarding/browser-authentication.test.ts --maxWorkers=1 --testNamePattern='rotates the backup recovery|refuses recovery rotation'
```
