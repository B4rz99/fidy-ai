# Kapso production launch check

## Post-reset verification (2026-10-22)

Production health reported `available` at `20fd17a37458f54031c771d0b9e1de24a5e98933`.
The dedicated-number webhook is active and the old sandbox webhook is inactive. The staged
configuration described below was consumed by the successful `b525295dd9a07569a8cf3a01b8411cb638859c4e`
release; the setup-time inactive/pending statements below describe that earlier checkpoint.

A fresh authorized greeting reached Fidy at 08:07 Bogotá. Kapso recorded HTTP 200 for the
inbound callback, HTTP 200 for the outbound send, and sent/delivered/read provider receipts.
The delivered callback returned 200; WhatsApp Web visibly displayed the disclosure. After
explicit approval, sending `Acepto` at 08:13 returned the Consent-recorded provider handoff;
its inbound and delivered callbacks also returned 200. The browser handoff displayed Google
and Microsoft choices. This establishes disclosure delivery and Consent-to-handoff, not a
completed provider association or a hosted Agent conversation on the new number.

The disclosure and handoff replies also exposed an unresolved status-callback observation: their initial
`whatsapp.message.sent` callbacks returned 401, then the two retries returned 503. The first
message's status lookup returned 200. A later read of its stored provider history contained
correlated sent/delivered/read receipts and passed the installed lifecycle verifier locally.
The original lookup response bytes were not retained, so that later response does not prove
what the first callback observed or establish a root cause. Existing native tests exercise
rejected proof and bounded lookup replay; neither receipt timing nor D1 exhaustion is claimed
as the cause. Keep signature, correlation, delivery-proof and resource-admission guards intact.

On the same revision with Effect 4.0.5, the current local rerun passed:

- 31 WhatsApp adapter checks across five files.
- 233 native checks across WhatsApp, provider association, onboarding Consent and Agent files.
- 61 controlled hosted-inference checks across three files.
- 38 Agent Core checks across five files.

These commands use controlled external responses and isolated local persistence; they do not
prove live inference, voice/media interpretation, proactive templates, or all new-number journeys.
The existing [Agent feature map](../../apps/web/src/features/agent/FEATURE.md) retains earlier
coverage and its separate live gaps.

The User subsequently completed Google sign-in. An authorized `Estado` request at 08:23
returned the intended QA account review, and its association identifier matched the browser
handoff. No account identifier or raw provider payload is retained here. The inbound callback
returned 200; the sent callback again returned 401. Association confirmation is deferred for
explicit approval when the User returns. Another audit retains the shared browser session;
no sign-out or further provider selection was performed by this audit. No financial fixture,
access grant, counter reset or history deletion was performed in this continuation.

## Dedicated-number cutover (2026-10-21)

Kapso CLI authenticated to project `e12c802f-113f-4a71-9516-d9c2191392e8` and verified the
connected production number **+1 205-687-1742**:

| Configuration            | Value                                              |
| ------------------------ | -------------------------------------------------- |
| WhatsApp phone number ID | `1397401100120558`                                 |
| Kapso configuration ID   | `d63b8abf-23ee-4f58-9ab1-98baa88f4980`             |
| Business portfolio ID    | `3582698951893989`                                 |
| Business account ID      | `1121409637522296`                                 |
| Fidy webhook ID          | `7eac1474-ffdc-4150-98d9-89a6a9195d3f`             |
| Callback                 | `https://api.fidyapp.com/providers/kapso/callback` |

Number health reported available messaging, verified webhook subscription, and passed number
access. The registered Fidy webhook uses Kapso payload v2 without buffering and subscribes to
`whatsapp.message.received`, `whatsapp.message.sent`, `whatsapp.message.delivered`, and
`whatsapp.message.failed`. It was **inactive** at this setup checkpoint, pending deployment and live verification.

GitHub's **Production environment** holds the updated `KAPSO_API_KEY`, the new
`KAPSO_WEBHOOK_SECRET`, and the verified `WHATSAPP_BUSINESS_PORTFOLIO_ID`. The environment's
`WHATSAPP_SANDBOX_PHONE_NUMBER_ID` override was removed. Never place those credentials in Git,
chat, command arguments, or this evidence file. The temporary webhook-secret capture was removed
after storage in GitHub. The old sandbox webhook had not been disabled at this setup checkpoint; it could not be treated
as verification of the new number.

Fidy obtains its business phone endpoint from authenticated inbound evidence and retains it for
the corresponding delivery; no unused global `KAPSO_PHONE_NUMBER_ID` binding was added. The new
number is not the sandbox endpoint, so ordinary BSUID delivery applies. Existing identity and
Consent associations are not migrated by changing configuration.

Local verification passed **31 WhatsApp adapter checks** and **89 native Worker checks**, including
onboarding Consent and WhatsApp provider association. A bounded unsigned POST to the deployed
callback returned **401**. These checks do not establish delivery through the new webhook or
validate the newly stored API key against Kapso. No WhatsApp message was sent during setup, and
Kapso returned no approved templates for the new number.

After a successful Production deployment consumes the new environment values:

1. Verify the deployed revision and normal account reads before admitting a test message.
2. Activate the new webhook and disable the old sandbox webhook using their exact number IDs.
3. Use an authorized test sender to message the dedicated number. Verify signature admission,
   disclosure delivery, the explicit Consent/provider association journey, and delivery status.
   Preserve the same-User and BSUID guards; a phone number is not identity authority.
4. Record live evidence and any remaining limits. Keep proactive delivery disabled until its
   approved template and opt-in checks pass; no template is currently available.

This staged cutover does not close the separate provider/legal launch evidence below.

## Provider launch evidence

The operator has accepted Kapso's indefinite Free-plan retention for the MVP; this is **not** approval of the real-user launch conditions in #713. Ordinary MVP deployments do not run this check. Before claiming the #713 launch gate is satisfied, run `bash infra/cloudflare/scripts/check-kapso-launch.sh` and complete `kapso-launch-evidence.json`. The checked-in file is intentionally **PENDING** for account-specific checks. The public Terms and DPA identify Kapso, Inc. and are effective September 17, 2026; the published subprocessor list is effective September 1, 2026. On September 28, 2026, the authenticated `kapso` CLI confirmed access to the `fiidy` project and exactly one WhatsApp number of kind `sandbox`. This does **not** establish that the current Terms were accepted for this account, that a production number is ready, or which transcript vendor is enabled. The operator reports that the project's dashboard says the Free plan keeps WhatsApp history indefinitely and requires an upgrade for automatic retention. The MVP accepts that setting with the published disclosure; it cannot satisfy the separate finite-retention requirement of #713. Prior messaging tests and `kapso status` prove neither retention nor deletion. Never put credentials, customer content, or private agreements in Git; evidence references must point to access-restricted records. The CI check validates completeness, **not** whether a dashboard claim is true. An operator must compare it with the live account at enablement and after provider changes.

1. In the Kapso account, identify the contracting entity and retain the accepted Terms and DPA versions, acceptance evidence, and the current subprocessor list. Verify which provider and configuration actually produce voice transcripts; list conditional AI/speech subprocessors in the restricted record. The public list alone does not prove which service is enabled for this project.
2. In **Project settings → Message retention**, select the shortest workable window, at most 30 days. Verify the _effective_ setting after any pending change completes (Kapso documents a 48-hour delay when shortening). Free projects default to indefinite retention and are not eligible. Record a dated screenshot or provider confirmation without personal data. Recheck after configuration or plan changes. [Kapso WhatsApp data](https://docs.kapso.ai/docs/platform/whatsapp-data).
3. Inspect Kapso agents, models, workflows, replay, sandbox, MCP, and analytics. Disable each unused feature; for any enabled feature, document the purpose and risk decision in the restricted review. Do not disable the Kapso-generated voice transcript used by Fidy. Review provider training/improvement settings separately, especially on a free plan.
4. With an expendable **test contact**, exercise deletion. Kapso's [erase contact API](https://docs.kapso.ai/api/platform/v1/contacts/erase-contact) queues asynchronous erasure; HTTP 204 is _not_ proof of completion. Confirm the contact and its conversations, messages, media, and transcripts are gone after processing. Verify whether active conversations, message logs, webhook logs, and backups remain and obtain Kapso support confirmation for any data not covered. Never test on a real User without the approved rights process. Record how support requests are raised, the identifiers to supply (use the BSUID, not a phone number as User authority), how completion is verified, and contractual exceptions. If the API does not cover the scope, keep the launch blocked until a tested executable support process does.
5. Review `apps/site/src/assets/policy.html` and `apps/server/src/shell/consent/internal/current-disclosure.ts` against those findings. The policy must remain understandable in Spanish and truthful about Kapso/Meta, foreign processing, conditional transcript subprocessors, and material retention/deletion limits. Changes to the wording require new disclosure revisions and SHA-256 digests.
6. Only then replace each `PENDING` in `kapso-launch-evidence.json` with the reviewed facts or restricted evidence reference, and run `bash infra/cloudflare/scripts/check-kapso-launch.sh`. Get the operator/legal reviewer to approve the record before enabling production traffic. Revoke approval if settings, contracts, subprocessors, or policy diverge.

For items the dashboard/API cannot verify, open a support case with `legal@kap.so` (Kapso's published privacy contact). Ask them to confirm the project's current retention and pending changes, the selected voice-transcription provider and any AI subprocessors, and whether erasure of an expendable test contact includes active conversations, transcripts, message/webhook logs, and backups. Request a completion reference, not just confirmation that a job was queued. Do not email raw messages, media, or credentials. Record the dated answer in access-restricted evidence before closing any pending field.

The Kapso retention window deletes _ended_ conversations and associated data after their last activity; it does not delete active conversations or contacts. Message logs have a separate limit. The DPA allows backup, legal, security, and audit exceptions. Fidy's own Transcript retention is a separate control. [Kapso DPA](https://kapso.com/dpa) · [Kapso subprocessors](https://kapso.com/subprocessors) · [Kapso privacy policy](https://kapso.ai/privacy).
