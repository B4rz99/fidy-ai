# Support recovery operator (#1086 / #1092)

`bun run cli support-recovery` authenticates an operator through Cloudflare Access, collects one
public BrowserLoginPairing reference and a hidden BackupRecoveryCode, and asks the existing Recovery
Worker to approve that pairing. The command creates no User, channel association or WebSession.
Browser Login still requires the original browser-private verifier.

| Action                         | Owner / runtime path                                                                                                             | Status and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Operator authentication        | CLI runtime → scoped `cloudflared access login --quiet` and `access token --app`, exact private route                            | Implemented; native adapter tests exercise real child processes with substituted cloudflared output, bounded JWT decoding and closed failure projection. Real Production email-PIN browser login and installed cloudflared authentication pass (2026-10-09).                                                                                                                                                                                                                                                                                                 |
| Claimant proof entry           | CLI operations / runtime, argument-free TTY prompts                                                                              | Implemented; command tests reject arguments, pipes, malformed proof and cancelled entry before decision; native terminal tests prove no echo and scoped reader release. No PAT store or environment/file proof input.                                                                                                                                                                                                                                                                                                                                        |
| Recovery decision              | One POST to `https://api.fidyapp.com/internal/support-recovery`, Access → public/Core Workers → Recovery / Browser Login D1 unit | Implemented; protected transport tests cover fixed route, status/body agreement, redirects, response limits, deadline and interruption. Both Google/Microsoft built-browser signup journeys invoke the command through real public/Core/D1, with terminal/Access edge substitutions. They prove same User recovery without WhatsApp/mailbox, replay refusal, private browser completion and fresh-session code rotation. Real Production CLI approval, original-browser completion into Transactions and session persistence after reload pass (2026-10-09). |
| Refusal and uncertain delivery | Closed Spanish output; no automatic retry                                                                                        | Implemented; malformed/lost/contradictory delivery is uncertain, interruption releases owned work, and no output includes claimant or operator proof. An uncertain result directs the same browser to inspect/complete, never blind replay.                                                                                                                                                                                                                                                                                                                  |

The existing [authentication feature map](../../../../docs/operations/authentication-feature-map.md)
records the full signup/login implementation. [Operator procedure](../../../../docs/operations/support-recovery.md)
defines Access policy, exact responses and approved proof. ADR 0020 retains Recovery and Browser Login
ownership; this command adds only private operator transport.

Production evidence (2026-10-09): after correcting deployment-token permissions, the
[release](https://github.com/B4rz99/fidy-ai/actions/runs/37878216469) succeeded for
`2801102cbf5e77eae6804d4fd4d98d7602716c9a`. Readback confirmed the dedicated Access
application, 15-minute policy, sole approved operator group and email-PIN provider;
release gates verified issuer/audience agreement. The User completed operator login and hidden
claimant proof entry. The CLI reported approval; the original pairing browser reached
Transactions and retained authenticated access after reload. No secret was copied into evidence.

Use the repository's pinned Bun executable directly when the shell PATH contains another Bun:
`/Users/obarbozaa/.fidy/bun-13a98b0db/bun apps/cli/src/main.ts support-recovery`.
Enter the public reference from the open pairing tab first, then the saved recovery code at the
second hidden prompt. Cloudflare Access success alone authenticates the operator.

The User confirmed Production refusal when replaying the consumed recovery code on the PR #1118
release. The original pairing browser remained awaiting approval without authenticated app access.
The User then completed fresh sign-in and rotation, saved the new code privately and returned to
Transactions. Navigation and reload of recovery settings expose only rotation, with no copy-code
control. These live checks establish replay refusal and post-recovery rotation on Production.
Recovery rotation
also has a confirmed error-classification bug: an active session older than ten minutes returns
`unauthenticated`, which the browser presents as expired. Fresh sign-in permits rotation. [PR #1117](https://github.com/B4rz99/fidy-ai/pull/1117) returns a reauthentication refusal with a sign-in link,
without expiring ordinary access. Both provider built-browser journeys and the Worker/D1 regression pass;
its [Production deployment](https://github.com/B4rz99/fidy-ai/actions/runs/37913919939) passed.
The User verified the deployed fresh-sign-in message; Transactions then loaded with the same
recovered session, confirming that refusal preserves ordinary access.

Follow-up Worker/D1 checks cover expired unredeemed recovery pairings, bounded rolling operator/global
admission and scheduled terminal evidence retention with atomic rollback. Thirty-nine focused tests
pass; [PR #1118](https://github.com/B4rz99/fidy-ai/pull/1118) merged after full CI and its
[Production release](https://github.com/B4rz99/fidy-ai/actions/runs/37917226691) passed every gate.
API and web metadata identify `fc6d29097638436d3c861123f740a7e8ce11103a`, and the recovered browser
session survives reload. The operator flow creates terminal approved decisions, with no open-case
retry lifecycle. Verified Titular deletion remains unimplemented.

Recovery decision timing: held-body Worker/D1 regressions previously approved after operator assertion
or pairing expiry. The follow-up rechecks verified assertion time and uses the post-read decision
instant for pairing/proof guards. Both exact-expiry regressions pass; PR #1118 deployed successfully.
