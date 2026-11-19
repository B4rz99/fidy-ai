# Manual Pro grants

An invited tester first registers a User. From the repository root, the assigned beta operator can then grant Pro until revoked, revoke manual access, or list active grants.

```sh
bun run pro grant tester@example.com
bun run pro list
bun run pro revoke tester@example.com
bun run pro grant --user-id 10000000-0000-4000-8000-000000000001
```

Install `cloudflared` and run the command in an interactive terminal. It opens Cloudflare Access for the exact `https://api.fidyapp.com/internal/beta-pro` application. Production sets `BETA_PRO_OPERATOR_EMAIL=obarboza@fidyapp.com` for this dedicated 15-minute application. Core verifies its audience, issuer, signed subject, email and expiration on every request. The protected installation remains closed during acceptance. Its runner must supply separate closed-release admission to the installed hostname.

Use an independently verified mailbox visible in Settings → Account, or the User's stable ID. Core resolves the Directory route, then the destination User checks the exact mailbox generation again when applying a change. An unresolved or replaced address, expired authority or erasure fence prevents a new decision.

The terminal records one request ID per command and can repeat that exact addressed request once after a transport failure. The User commits the grant or revocation with ordered immutable operator evidence and native storage admission. After an uncertain final response, use `bun run pro list` to inspect current grants before issuing a distinct decision.

`list` reads bounded pages and prints JSON only after the final page succeeds. Output contains the stable User ID and current grant action. It refuses a result above 1,000 active Users. Each User supplies its current decision and erasure status. Concurrent grant or revoke operations can take effect while the command traverses different Users.

Granting Pro changes manual standing only. Trial and paid access continue according to their own terms, payment history stays intact, and Consent and resource limits continue to apply.
