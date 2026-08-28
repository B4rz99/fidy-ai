# Support recovery

## Purpose

This procedure approves an existing BrowserLoginPairing for an existing User who controls neither
their VerifiedEmailCredential nor WhatsAppIdentity but still holds the BackupRecoveryCode disclosed
at onboarding. It never creates a User, changes a VerifiedEmailCredential, reassociates a
WhatsAppIdentity, or creates a WebSession. The browser-held private verifier remains required.

## Launch configuration

Cloudflare Access must define a dedicated path application for only:

```text
POST https://api.fidyapp.com/internal/support-recovery
```

Restrict its allow policy to the `recovery-operator` group and set the user session duration to 15
minutes. Record the application's immutable audience tag in Railway as
`CLOUDFLARE_ACCESS_AUDIENCE`. Set `CLOUDFLARE_ACCESS_ISSUER` to the exact HTTPS team issuer, such as
`https://fidy.cloudflareaccess.com`. Cloudflare enforces the application audience at the edge; the
Railway origin independently verifies the forwarded assertion against the issuer JWKS and checks its
signature, exact issuer, exact audience, nonfuture issued-at time, expiry no farther than 15 minutes
from verification, maximum 15-minute assertion lifetime, and nonempty subject. Missing or malformed configuration prevents server startup.

This Access application and allow policy are launch blockers, not optional dashboard guidance. Before
promoting the server, the release operator must verify in Cloudflare Zero Trust that the application
path, `recovery-operator` group, 15-minute session, and Railway audience value exactly match this
section; otherwise the support command must remain unavailable.

The route is private transport, not a canonical operation. It must remain absent from public
OpenAPI, generated clients, browser routes, and hosted-agent tools. Generic HTTP request logging is
disabled; do not add route, header, request-body, response-body, or JWT logging.

The operator workstation requires `cloudflared`. The CLI uses `cloudflared access login` and
`cloudflared access token` interactively; it receives no database credential.

## Procedure

1. Ask the User to start a new BrowserLoginPairing in the same browser they will continue using.
2. Accept only its public reference and the pre-issued BackupRecoveryCode. The User enters no
   browser-private verifier into support.
3. Run `bun run --cwd apps/server support:recovery` from an approved operator workstation.
4. Complete the interactive Cloudflare Access login. Enter the public pairing reference when
   prompted, then enter the BackupRecoveryCode in the hidden prompt.
5. Communicate only the exact result below. Never disclose whether the pairing reference, recovery
   code, credential lifecycle, or User association matched.
6. On approval, tell the User to return immediately to the same browser. The browser must still
   redeem its private verifier to create the ordinary WebSession.
7. After recovery, direct the User to **Recuperación** in the signed-in settings and create a new
   BackupRecoveryCode. It is shown once; the previous code is unusable.

The CLI never accepts the BackupRecoveryCode through argv, environment variables, shell
interpolation, or command history. Do not paste it into tickets, chat, notes, screenshots, logs, or
incident systems.

## Approved evidence and forbidden evidence

The only approved evidence is both:

- the live BrowserLoginPairing public reference; and
- the BackupRecoveryCode issued before the loss of access.

Do not request or accept identity documents, selfies, financial facts, Transactions, card or account
numbers, bank statements, a newly supplied email address, or a newly supplied phone number as
ownership proof. Fidy performs no KYC, and financial history never defines User identity.

## Exact communication

Success:

> Recuperación aprobada. Vuelve de inmediato al mismo navegador donde iniciaste la vinculación y continúa allí. No cierres esa pantalla ni compartas información adicional del navegador con soporte.

Generic refusal:

> No pudimos aprobar la recuperación. La información proporcionada o la vinculación no permiten continuar. Si aún conservas tu código de recuperación, inicia una nueva vinculación y vuelve a contactar a soporte. No envíes documentos, datos financieros ni números de tarjeta o cuenta.

Every established proof lost:

> Si ya no tienes acceso a tu correo verificado, a tu WhatsApp ni a tu código de recuperación, Fidy no puede recuperar tu acceso. No aceptamos documentos, datos financieros, correos ni teléfonos nuevos como prueba de titularidad.

Operator-only failure:

> La operación de soporte no está disponible. No se tomó una decisión de recuperación. Escala el incidente por el canal interno.

An admission limit is the operator-only failure plus the CLI's bounded retry delay. It contains no
claimant detail. Do not turn an operational failure into a recovery decision.

## Admission and refusal

Every invocation with a valid Access assertion is counted before body decoding, including malformed
or unattributable input. Launch limits are:

- 5 admitted commands per rolling minute and 20 per rolling hour for one verified operator;
- 20 admitted commands per rolling minute and 100 per rolling hour globally;
- 100 open SupportRecoveryCases globally;
- one open case per User; and
- five attributable rejections per case.

Admission evidence is retained for exactly one hour. The fifth attributable rejection closes the
case as refused. An open case expires no later than its BrowserLoginPairing. Approved, refused, and
expired cases never resume.

Escalate invalid Access configuration, JWKS failures, database unavailability, repeated operator
limits, or unexpected safe failures through the internal incident channel. Escalation may include
timestamp, operator issuer/subject, HTTP status, and safe failure class only—never a JWT, pairing
reference, BackupRecoveryCode, request body, User prose, or match detail.

## Retention and Titular deletion

Terminal SupportRecoveryCases and their append-only metadata events are retained for exactly 24
months from `closedAt`, then deleted together in fixed batches. Routine deletion may set a consumed
credential's case reference to null while retaining `consumedAt`; this never restores credential
authority.

A verified Titular deletion immediately deletes their SupportRecoveryCases, events, and Recovery
credential as part of the User-deletion transaction. There is no legal-hold exception at launch. A
future actual legal obligation requires a tracked policy and ADR change before behavior changes.
