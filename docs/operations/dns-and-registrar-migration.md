# DNS and registrar migration

This runbook moves authoritative DNS for `fidyapp.com` from Vercel to Cloudflare, preserves Google
Workspace and Resend, and transfers registration from Spaceship only after the Cloudflare zone is
active. The product is unreleased, so this procedure does not add zero-downtime or rollback
machinery.

Record command output and screenshots in the operator's private change record; DNS values can expose
provider account details and do not belong in the repository.

## 1. Inventory and eligibility

1. Export every Vercel DNS record, including names, types, values, priorities, TTLs, and verification
   records. Separately record all Google Workspace MX/TXT records and all Resend records below
   `ingest.fidyapp.com`.
2. In Spaceship, record expiration, auto-renewal, registrant email, current nameservers, domain lock,
   transfer eligibility date, and status codes. `clientTransferProhibited` means the domain must be
   unlocked before transfer.
3. Confirm that at least 60 days have elapsed since initial registration and any prior transfer, and
   that no registrant-contact change has created another 60-day transfer lock.
4. Record current DNSSEC state. If Spaceship currently publishes a DS record for Vercel DNS, obtain
   the exact safe removal sequence before changing nameservers. A stale parent DS record causes
   validation failure.

## 2. Build the Cloudflare zone

1. Add `fidyapp.com` to the intended Cloudflare account without changing nameservers.
2. Recreate and compare the full record inventory. Preserve Google Workspace root MX records and its
   SPF/DKIM/verification records. Preserve Resend's inbound MX plus SPF/DKIM records at
   `ingest.fidyapp.com`. Never put Resend inbound MX at the root.
3. Create the Production web custom-domain binding for `fidyapp.com` and the Railway custom domain
   for `api.fidyapp.com`. Use provider-issued targets; do not invent A records.
4. Review proxy mode per record. Mail records are DNS-only. HTTP records use the mode required by the
   owning provider and certificate validation.
5. If useful, lower TTLs at Vercel before the change and wait one old TTL. This is convenience, not a
   zero-downtime requirement.

## 3. Move authority

1. Remove the old parent DS record when required by the DNSSEC transition plan and verify with
   `dig +short DS fidyapp.com`. Do not enable Cloudflare DNSSEC yet.
2. In Spaceship, replace the Vercel nameservers with the two nameservers assigned by the Cloudflare
   zone.
3. Wait until Cloudflare reports the zone Active. Verify from multiple public resolvers:

   ```sh
   dig +short NS fidyapp.com
   dig +short MX fidyapp.com
   dig +short MX ingest.fidyapp.com
   dig +short TXT fidyapp.com
   curl --fail https://fidyapp.com/deployment-metadata.json
   curl --fail https://api.fidyapp.com/health
   ```

4. Send and receive controlled messages through Google Workspace and Resend. Confirm their provider
   consoles still report the records verified.
5. Enable DNSSEC in Cloudflare, copy its DS values into Spaceship, and verify the parent DS and zone
   DNSKEY chain. Do not leave DNSSEC half-configured.

## 4. Transfer registration

Begin only after the Cloudflare zone is Active and the DNS and mail checks pass. Registration
transfer does not move DNS authority; the active Cloudflare zone should continue answering.

1. Confirm transfer eligibility and that expiration is not in an unsafe provider-specific window.
2. Disable Spaceship's registrar lock and verify `clientTransferProhibited` has cleared in RDAP/WHOIS.
3. Request the EPP/AuthCode only after unlocking. Treat it as a Secret: do not store it in GitHub,
   tickets, chat, logs, or this repository.
4. Start the transfer in Cloudflare Registrar, enter the AuthCode directly, approve confirmation
   email, and monitor both registrars until completion.
5. Verify the registration expiration includes the expected renewal year, Cloudflare auto-renewal is
   enabled, contact email is correct, registrar lock is restored, nameservers are unchanged, and
   DNSSEC remains valid.
6. Re-run the DNS, HTTPS, Google Workspace, and Resend checks. Remove obsolete Vercel DNS only after
   the transfer and verification record is complete.
