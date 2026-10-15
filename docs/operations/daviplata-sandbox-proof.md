# DaviPlata reusable-enrollment Sandbox protocol proof

Issue: [#232](https://github.com/B4rz99/fidy-ai/issues/232).

## Status and launch boundary

**The protected live Sandbox protocol and first-payment proof passed all four selected cases.**
The ordinary adapter/proof-helper tests use synthetic transport premises, not recorded provider responses.
Credentials, checked-in tests and a manual workflow do not establish merchant eligibility or actual
OTP origins, paths, browser CORS, recovery or reusable-source behavior.

On 2026-10-15, bounded manual tokenization with the browser-published Sandbox public key and
documented synthetic CC/product returned 201/PENDING. Both service URLs used
`https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox`, with exactly the
`token` and `operation` query keys. The token query matched the returned authorization ID;
operations were `RESEND_OTP` and `VALIDATE_OTP_API`. No bearer or OTP was sent to either service.
The prior policy rejected that host and query shape. The adapter now supports that exact Sandbox
endpoint, constructing token/operation queries from the bound authorization instead of forwarding
provider URLs. Discovery alone does not verify OTP, source or settlement.
Raw payloads, authorization IDs and query values containing identity are not retained.
A 2026-10-15 OPTIONS probe to the exact endpoint with the Fidy app Origin returned 200,
`Access-Control-Allow-Origin: *`, POST allowed, and authorization/content-type allowed. This is
preflight evidence only, not a browser OTP POST or completed authorization.

Production enablement remains blocked on real protocol, browser CORS and interruption/recovery
proofs. This server-side synthetic Sandbox proof does not proxy any User's account details or
replace the browser authorization boundary. Native-platform launch evidence remains separate.

## Required reviewed configuration

The manual `.github/workflows/daviplata-sandbox.yml` workflow accepts only `trunk` and uses the existing
protected `production` environment that holds the Wompi **Sandbox** secrets. It receives only
`WOMPI_ENVIRONMENT`, `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY` and `WOMPI_INTEGRITY_SECRET` secrets;
it receives no Cloudflare credentials and deploys nothing. Environment must be `sandbox`, and keys
must match Sandbox prefixes.

The manual proof pins the observed endpoint in its own workflow. Deployment still requires
separate protected-environment **variables**:

- `WOMPI_DAVIPLATA_OTP_SEND_URL`
- `WOMPI_DAVIPLATA_OTP_CONFIRM_URL`

The workflow and any later reviewed deployment configuration use the observed, query-free Sandbox endpoint:
`https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox`.
The adapter constructs the exact query with the returned authorization ID and either
`RESEND_OTP` or `VALIDATE_OTP_API`. Both returned URLs must match those constructed destinations
before any service bearer or OTP leaves the process. Altered hosts, paths, identity, operations,
extra query fields, credentials and fragments are refused. The browser CSP allows only the new
host's exact service path. Production-mode destinations and merchant activation remain separately
gated; this Sandbox observation does not establish the Production protocol or browser CORS.

Missing, malformed or non-Sandbox policy rejects before tokenization or other provider effects.
Running this proof does not set deployment variables or enable DaviPlata in the deployed app.
After the passing run below, both protected `production` environment OTP variables were set to the
reviewed Sandbox endpoint. The release workflow now forwards them into every Alchemy plan/apply
step. `WOMPI_DAVIPLATA_ACTIVATED` remains unset/default-disabled: real-payment activation is not
authorized by this Sandbox configuration. Deployed availability must be checked after release.
Do not download credentials, dispatch from an unreviewed branch, enable HTTP/body tracing, or
retain provider payloads as fixtures/artifacts.

## Proof scope

The opt-in `proves Sandbox DaviPlata` cases in
`apps/server/cloudflare/subscription/payment-enrollment.test.ts` run only with
`FIDY_DAVIPLATA_SANDBOX=1`. Closed Outbound HTTP requests own fixed documented synthetic CC/document
and approved/declined product data, plus the documented approval OTP. There is no User-supplied
account-data input. The sequence is:

1. Real Sandbox tokenization for the selected synthetic outcome.
2. Exact comparison of both returned OTP service URLs to the configured destination plus bound authorization and operation.
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
record its successful run link and revision here. The [first protected run](https://github.com/B4rz99/fidy-ai/actions/runs/38788575817) at
`84db84ee2a19bb34a2c8cb435733afa07d8340b5` failed all four cases on 2026-10-15. Its original
redaction erased the failing step, so it proves no completed OTP/source/settlement journey. The
proof now retains only fixed step names and still discards provider values and underlying errors;
the [diagnostic rerun](https://github.com/B4rz99/fidy-ai/actions/runs/38791246089) at
`e1a1d4d81acbedff552242d3a3e73994592eaeae` stopped at `otp-send-request`. A bounded
public-key-only probe confirmed that Wompi now returns `daviplata_test_` identities, which the
adapter rejected because it allowed only the documented older `devtest`/`devint` prefixes.
Regression checks reproduced that refusal in outbound transport, browser authorization and Core/local
D1 enrollment. After accepting the observed Sandbox prefix while preserving Production separation,
a separate public-key-only probe through the real outbound adapter completed tokenization, OTP send
and OTP confirmation. No reusable source or charge was created by that probe; no provider payload or
identity was retained. The subsequent [protected run](https://github.com/B4rz99/fidy-ai/actions/runs/38793956290) at
`90c912702f3a4286d66fae29a4eaa78aa5cbfefa` passed all four selected cases on 2026-10-15 at
14:34 Bogotá: weekly, monthly and yearly approved first payments, plus a declined weekly payment.
Each completed real tokenization, exact OTP destination/identity binding, OTP send/confirmation,
authenticated reusable-source verification and independently verified settlement; the declined
case had no paid period. Execution used local D1/activity harnesses with the real Wompi Sandbox.
It does not prove deployed browser OTP CORS, Queue/Workflow, restart or webhook delivery.
The prefix-fix [Production deployment](https://github.com/B4rz99/fidy-ai/actions/runs/38793940880)
passed its candidate, intermediate, normal-traffic and drift gates. This is release evidence, not
a deployed DaviPlata payment. Credentials stay in the protected workflow. Source revocation/replacement, recovery and
automatic-renewal execution remain separate work.

## Primary references

- [Payment sources and DaviPlata tokenization](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)
- [Sandbox test data — DaviPlata recurring payments](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/)

The provider docs specify CC document `1122233`, product `3991111111` for approved transactions,
product `3992222222` for declined transactions, and OTP `574829` to approve the reusable token.
They document bearer rotation and OTP service URLs returned by tokenization, but their illustrative
URLs are not approved configuration or actual CORS evidence.
