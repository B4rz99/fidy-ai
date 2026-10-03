# DaviPlata reusable-enrollment Sandbox protocol proof

Issue: [#232](https://github.com/B4rz99/fidy-ai/issues/232).

## Status and launch boundary

**The live proof has not been run, and no successful real Sandbox evidence is recorded.**
The adapter/proof-helper tests use synthetic transport premises, not recorded provider responses.
Credentials, checked-in tests and a manual workflow do not establish merchant eligibility or actual
OTP origins, paths, browser CORS, recovery or reusable-source behavior.

Production enablement remains blocked on real protocol, browser CORS and interruption/recovery
proofs. This server-side synthetic Sandbox proof does not proxy any User's account details or
replace the browser authorization boundary. Native-platform launch evidence remains separate.

## Required reviewed configuration

The manual `.github/workflows/daviplata-sandbox.yml` workflow accepts only `trunk` and uses the existing
protected `production` environment that holds the Wompi **Sandbox** secrets. It receives only
`WOMPI_ENVIRONMENT`, `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY` and `WOMPI_INTEGRITY_SECRET` secrets;
it receives no Cloudflare credentials and deploys nothing. Environment must be `sandbox`, and keys
must match Sandbox prefixes.

An operator must separately review and explicitly set these protected-environment **variables**:

- `WOMPI_DAVIPLATA_OTP_SEND_URL`
- `WOMPI_DAVIPLATA_OTP_CONFIRM_URL`

There are intentionally **no example URLs, defaults, wildcard origins or guessed paths**. Both must
satisfy the current `DaviplataOtpPolicy`: HTTPS, exact `sandbox.wompi.co` origin, a bounded permitted
path, and no credentials/query/fragment. Actual provider OTP
service origins/paths and CORS are unknown. If real service URLs do not satisfy this policy, the
proof must stop; do not broaden policy just to obtain a green run. Review provider evidence and the
security/product decision first.

Missing, malformed or non-Sandbox policy rejects before tokenization or other provider effects.
The tokenization response must return both configured URL strings **exactly**, before any OTP
service bearer or synthetic OTP is sent. Same-origin path variations are not accepted.
Do not download credentials, dispatch from an unreviewed branch, enable HTTP/body tracing, or
retain provider payloads as fixtures/artifacts.

## Proof scope

The opt-in `proves Sandbox DaviPlata` cases in
`apps/server/cloudflare/subscription/payment-enrollment.test.ts` run only with
`FIDY_DAVIPLATA_SANDBOX=1`. Closed Outbound HTTP requests own fixed documented synthetic CC/document
and approved/declined product data, plus the documented approval OTP. There is no User-supplied
account-data input. The sequence is:

1. Real Sandbox tokenization for the selected synthetic outcome.
2. Exact comparison of both returned OTP service URLs to reviewed configuration.
3. One OTP-send POST with the returned one-use service bearer; verify the same authorization identity.
4. One OTP-confirm POST with the newly returned bearer and fixed synthetic approval OTP; verify the
   same authorization is approved.
5. Submit to the server enrollment path, which independently verifies token approval, creates a
   reusable source and authenticates matching `AVAILABLE` `DAVIPLATA` source identity/environment.
6. Run the existing BillingAttempt collection and settlement path. Weekly, monthly and yearly first
   payments must reach matching verified success. The declined weekly first payment must reach the
   existing bounded failure decision, with no paid period.

Token approval, source creation or transaction POST acceptance alone cannot pass. Local D1 and
Workflow activity harnesses share the normal enrollment fixture/migrations; the provider is real
only in the opt-in run. This is not deployed Queue/Workflow, restart, webhook-delivery or browser
CORS evidence. Bounded source-observation and settlement polls are allowed; tokenization, OTP and
ambiguous source/charge POSTs are never blindly replayed. Failures collapse to fixed metadata-only
errors, and live payloads never enter assertion diffs. The job summary records only revision,
completed scenarios and evidence scope.

After reviewed configuration and merge, an authorized operator may run the protected workflow and
record its successful run link and revision here. **No run is currently linked.** This task neither
retrieves credentials nor dispatches the workflow. Source revocation/replacement, recovery and
automatic-renewal execution remain separate work.

## Primary references

- [Payment sources and DaviPlata tokenization](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)
- [Sandbox test data — DaviPlata recurring payments](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/)

The provider docs specify CC document `1122233`, product `3991111111` for approved transactions,
product `3992222222` for declined transactions, and OTP `574829` to approve the reusable token.
They document bearer rotation and OTP service URLs returned by tokenization, but their illustrative
URLs are not approved configuration or actual CORS evidence.
