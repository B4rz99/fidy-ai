# DNS and registrar migration

This runbook moves authoritative DNS for `fidyapp.com` to Cloudflare while preserving approved mail
and registrar records. The product is unreleased, so this procedure does not add zero-downtime or
rollback machinery.

Record command output and screenshots in the operator's private change record; DNS values can expose
provider account details and do not belong in the repository.

## Inventory and eligibility

1. Export every current DNS record, including names, types, values, priorities, TTLs, and verification
   records. Separately record Google Workspace mail records and any Cloudflare Email Worker routes.
2. Record registrar expiration, auto-renewal, lock, transfer eligibility, and DNSSEC state.
3. Confirm transfer and DNSSEC changes have an explicit operator-approved sequence. A stale parent DS
   record can make the domain unavailable.

## Build the Cloudflare zone

1. Add `fidyapp.com` to the intended Cloudflare account without changing nameservers.
2. Recreate and compare the complete record inventory. Preserve approved root mail records and their
   SPF, DKIM, and verification records.
3. Create the `fidyapp.com` custom domain for the static web Worker. Add an API Worker custom domain
   only after that Worker exists and its smoke checks pass.
4. Provision Email Worker MX routes through Cloudflare when inbound email is enabled. Do not create a
   legacy inbound-provider webhook or MX route.
5. Review proxy mode and certificate validation for every HTTP record. Mail records follow the owning
   mail service's requirements.

## Move authority

1. Follow the reviewed DNSSEC sequence; do not leave a parent DS record pointing at the old zone.
2. Replace the registrar nameservers with the two nameservers assigned by Cloudflare.
3. Wait until Cloudflare reports the zone active, then verify from multiple public resolvers:

   ```sh
   dig +short NS fidyapp.com
   dig +short MX fidyapp.com
   dig +short TXT fidyapp.com
   curl --fail https://fidyapp.com/deployment-metadata.json
   ```

4. Exercise only controlled, synthetic Email Worker input and verify bounded admission and safe
   handoff. Never use real personal or financial content for DNS verification.
5. Enable DNSSEC in Cloudflare, publish its DS values at the registrar, and verify the parent DS and
   DNSKEY chain.

## Transfer registration

Begin only after the Cloudflare zone is active and DNS checks pass. Registration transfer does not
move DNS authority.

1. Confirm transfer eligibility and disable the registrar lock only for the reviewed transfer window.
2. Request the EPP/AuthCode directly in the registrar UI. Treat it as a Secret: never store it in Git,
   tickets, chat, logs, or this repository.
3. Start the transfer in the chosen registrar and monitor both registrars until completion.
4. Verify expiration, auto-renewal, contact email, lock, nameservers, and DNSSEC. Remove obsolete DNS
   records only after the new authority is verified.
