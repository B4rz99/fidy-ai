# Support recovery

## Purpose

This procedure approves an existing BrowserLoginPairing for an existing User who has lost every
established authentication proof but still holds the BackupRecoveryCode disclosed at onboarding.
Provider-created Users need neither a WhatsAppIdentity nor a VerifiedEmailCredential. It never creates a User, changes a VerifiedEmailCredential, reassociates a
WhatsAppIdentity, or creates a WebSession. The browser-held private verifier remains required.

## Launch configuration

Cloudflare Access must define a dedicated private Worker route for only:

```text
POST https://api.fidyapp.com/internal/support-recovery
```

Restrict its allow policy to the `recovery-operator` group and set the user session duration to 15
minutes. Production Alchemy owns the dedicated path application, its email-PIN identity provider
and the group with exactly `RECOVERY_OPERATOR_EMAIL`. Configure that email in the GitHub Production
environment variable and the existing organization issuer in `CLOUDFLARE_ACCESS_ISSUER`.
Core receives the application's generated audience directly; no manually entered audience secret is
used by deployment. Issuer and audience are public JWT verification metadata, not credentials.
The private Worker must
verify the forwarded assertion against the issuer JWKS and check its signature, exact issuer, exact
audience, nonfuture issued-at time, expiry no farther than 15 minutes from verification, maximum
15-minute assertion lifetime, and nonempty subject. Missing or malformed configuration makes the
route unavailable.

This Access application and allow policy are launch blockers, not optional dashboard guidance. Before
promotion, `production-release.ts stage` reads the actual application, policy, group, login provider,
organization and uploaded Core version. It refuses missing resources, broader group membership,
non-15-minute authority or issuer/audience mismatches. The account's existing Zero Trust organization
must be configured first; deployment does not overwrite organization-wide settings.

The deployment API token needs account-scoped Access applications/policies, groups and identity
providers edit permissions and organizations read permission. The observability token needs only
the corresponding read permissions for verification. Keep token values out of repository files
and terminal output.

The route is private transport, not a canonical operation. It must remain absent from public OpenAPI,
generated clients, browser routes, and hosted-agent tools. Generic HTTP request logging is disabled;
do not add route, header, request-body, response-body, or JWT logging.

The private Worker, atomic D1 approval adapter and `bun run cli support-recovery` operator command
are implemented. The command requires the pinned Bun runtime, installed `cloudflared`, and an
interactive stdin and stderr terminal. It accepts no arguments, `--json`, files or piped input, and
does not use the saved Fidy PAT or native credential store. Cloudflared opens the Access browser login
for the exact route with `--quiet`; its diagnostics are suppressed and the bounded JWT is captured
privately. Cloudflared owns its ordinary short-lived Access token cache; Fidy retains neither that
assertion nor the claimant's recovery code. Authenticate as the intended operator before proceeding.

The command reads the public reference and recovery code without echo, then submits one bounded POST
with `cf-access-token`; Access supplies the origin assertion verified by the Worker. Redirects are
refused, the response is bounded, and the request has a 15-second deadline. Lost, malformed or
contradictory responses and interruption after submission are uncertain: do not repeat the decision;
return to the same browser to inspect and complete the pairing, or escalate without secrets.
The CLI has no database credential, queue or local recovery authority. Its closed terminal output
needs no extra client telemetry; the Worker's metadata-only recovery evidence remains authoritative.

Local command tests and both provider browser journeys exercise this operator workflow through real
public/Core Workers and D1, substituting terminal entry and external Access authentication. Live
Production Access policy, operator login, CLI approval and original-browser session completion were verified on 2026-10-09. Consumed-code replay and post-recovery rotation still need live verification.

## Procedure

1. Ask the User to start a new BrowserLoginPairing in the same browser they will continue using.
2. Accept only its public reference and the pre-issued BackupRecoveryCode. The User enters no
   browser-private verifier into support.
3. Run the repository-pinned Bun directly from an interactive terminal, for example
   `/Users/obarbozaa/.fidy/bun-13a98b0db/bun apps/cli/src/main.ts support-recovery`,
   if the shell PATH selects a different Bun. Complete Cloudflare Access in
   the browser as the recovery operator, enter the public pairing reference, then enter the
   BackupRecoveryCode in the hidden prompt. Do not run `cloudflared access token` separately or
   print/copy the assertion.
4. Communicate only the exact result below. Never disclose whether the pairing reference, recovery
   code, credential lifecycle, or User association matched.
5. On approval, tell the User to return immediately to the same browser. The browser must still
   redeem its private verifier to create the ordinary WebSession.
6. After recovery, direct the User to **Recuperación** in signed-in settings and create a new
   BackupRecoveryCode. It is shown once; the previous code is unusable.

The operator interface never accepts the BackupRecoveryCode through URL parameters, argv, environment
variables, shell interpolation, or command history. Do not paste it into tickets, chat, notes,
screenshots, logs, or incident systems.

## Approved evidence and forbidden evidence

The only approved evidence is both:

- the live BrowserLoginPairing public reference; and
- the BackupRecoveryCode issued before the loss of access.

Do not request or accept identity documents, selfies, financial facts, Transactions, card or account
numbers, bank statements, a newly supplied email address, or a newly supplied phone number as ownership
proof. Fidy performs no KYC, and financial history never defines User identity.

## Exact communication

Success:

> Recuperación aprobada. Vuelve de inmediato al mismo navegador donde iniciaste la vinculación y continúa allí. No cierres esa pantalla ni compartas información adicional del navegador con soporte.

Generic refusal:

> No pudimos aprobar la recuperación. La información proporcionada o la vinculación no permiten continuar. Si aún conservas tu código de recuperación, inicia una nueva vinculación y vuelve a contactar a soporte. No envíes documentos, datos financieros ni números de tarjeta o cuenta.

Every established proof lost:

> Si ya no tienes acceso a tu cuenta de Google o Microsoft, a tus otros medios de acceso establecidos ni a tu código de recuperación, Fidy no puede recuperar tu acceso. No aceptamos documentos, datos financieros, correos ni teléfonos nuevos como prueba de titularidad.

Operator-only failure:

> La operación de soporte no está disponible. No se tomó una decisión de recuperación. Escala el incidente por el canal interno.

An admission limit is the operator-only failure. It contains no claimant detail. Do not turn an
operational failure into a recovery decision.

## Admission and refusal

Every invocation with a valid Access assertion is counted before body decoding, including malformed or
unattributable input. Launch limits are:

- 5 admitted commands per rolling minute and 20 per rolling hour for one verified operator;
- 20 admitted commands per rolling minute and 100 per rolling hour globally.

The admission transaction removes expired evidence and conditionally inserts metadata before body
decoding. At most 100 admissions remain in the rolling hour; denied requests retain no body or proof.
Scheduled cleanup also removes expired admission metadata when operators stop making requests.

The current proof flow creates a terminal approved case only when the pre-issued code and pending
pairing match. Invalid proof cannot attribute a User and creates no case. There is no open-case retry
or five-rejection lifecycle in the deployed adapter; prior descriptions of those controls were inaccurate.

Escalate invalid Access configuration, JWKS failures, D1 unavailability, repeated operator limits, or
unexpected safe failures through the internal incident channel. Escalation may include timestamp,
operator issuer/subject, HTTP status, and safe failure class only—never a JWT, pairing reference,
BackupRecoveryCode, request body, User prose, or match detail.

## Retention and Titular deletion

Terminal SupportRecoveryCases and their append-only metadata events become eligible for deletion
24 calendar months from `closedAt`. Core Maintenance deletes them together in batches of at most
32 cases. A failed case deletion rolls back event deletion. Consumed credentials are untouched;
cleanup never restores credential authority. Referenced BrowserLoginPairings survive ordinary
expiry pruning until their retained case evidence is deleted.

Verified Titular deletion is not implemented by this recovery adapter and remains a feature gap.
It must delete cases, events and the Recovery credential as part of the User-deletion atomic unit;
this procedure does not establish that behavior.
