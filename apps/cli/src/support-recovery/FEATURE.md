# Support recovery operator (#1086 / #1092)

`bun run cli support-recovery` authenticates an operator through Cloudflare Access, collects one
public BrowserLoginPairing reference and a hidden BackupRecoveryCode, and asks the existing Recovery
Worker to approve that pairing. The command creates no User, channel association or WebSession.
Browser Login still requires the original browser-private verifier.

| Action                         | Owner / runtime path                                                                                                             | Status and evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Operator authentication        | CLI runtime → scoped `cloudflared access login --quiet` and `access token --app`, exact private route                            | Implemented; native adapter tests exercise real child processes with substituted cloudflared output, bounded JWT decoding and closed failure projection. Real Access login remains unverified.                                                                                                                                                                                                                           |
| Claimant proof entry           | CLI operations / runtime, argument-free TTY prompts                                                                              | Implemented; command tests reject arguments, pipes, malformed proof and cancelled entry before decision; native terminal tests prove no echo and scoped reader release. No PAT store or environment/file proof input.                                                                                                                                                                                                    |
| Recovery decision              | One POST to `https://api.fidyapp.com/internal/support-recovery`, Access → public/Core Workers → Recovery / Browser Login D1 unit | Implemented; protected transport tests cover fixed route, status/body agreement, redirects, response limits, deadline and interruption. Both Google/Microsoft built-browser signup journeys invoke the command through real public/Core/D1, with terminal/Access edge substitutions. They prove same User recovery without WhatsApp/mailbox, replay refusal, private browser completion and fresh-session code rotation. |
| Refusal and uncertain delivery | Closed Spanish output; no automatic retry                                                                                        | Implemented; malformed/lost/contradictory delivery is uncertain, interruption releases owned work, and no output includes claimant or operator proof. An uncertain result directs the same browser to inspect/complete, never blind replay.                                                                                                                                                                              |

The existing [authentication feature map](../../../../docs/operations/authentication-feature-map.md)
records the full signup/login implementation. [Operator procedure](../../../../docs/operations/support-recovery.md)
defines Access policy, exact responses and approved proof. ADR 0020 retains Recovery and Browser Login
ownership; this command adds only private operator transport.

Remaining Production checks: deployed Access application, operator group, issuer/audience and
15-minute assertion policy; installed cloudflared browser login and edge assertion forwarding;
provider-created User recovery with the original browser verifier, single-use refusal and rotation;
deployed D1/migrations, session persistence/logout/expiry, real providers/WhatsApp and secret exclusion.
Local fixtures establish no live provider, Access or Production-readiness evidence.
