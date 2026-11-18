# Reviewing an IngestSample

Set the Production environment variable `SAMPLE_REVIEWER_EMAIL` to the human who has explicit approval to review samples. An empty value leaves review unassigned. The release creates a dedicated 15-minute Cloudflare Access application for that exact email. The reviewer authenticates through `cloudflared` in a local interactive terminal.

Run `fidy sample-review review` and enter the stable User ID at the prompt. The CLI presents the oldest eligible candidate for that User. It shows its revision, SHA-256, interpretation metadata and bounded HTML tag counts. Verify that the candidate contains only anonymous structure. Enter **APROBAR** to approve those exact bytes, **RECHAZAR** to discard the candidate, or press Enter to leave it pending. Raw email and unreviewed candidates retain the email's original 90-day deadline.

A successful approval returns an independent sample ID. If the response is lost, use `fidy sample-review retry` with the original User ID, candidate ID, revision and digest under the same reviewer identity. An accepted publication can be pending while its User alarm reconciles R2.

Use `fidy sample-review withdraw` with the published sample ID and enter **RETIRAR** to remove its bytes. This works after the source User is erased. The independent withdrawal receipt is private and contains the reviewer issuer, subject and time. It also fences future writes to that sample ID.

## Account erasure handoff

On admission, establish the User's erasure fence and make every approved, unsettled `ingest_sample_decisions` row immediately due. The native User ingestion alarm detects that fence, clears its approved bytes, and changes the phase to `removing`. Keep the User available for bounded reconciliation while either an `approved` or `removing` row or an `ingest_sample_reservations` row remains.

Only a returned R2 reservation result or a positively observed matching random nonce settles that reservation. A missing key or elapsed deadline leaves it pending. Revocation marks the independent ID privately, then deletes the payload. Any delayed payload must match its original placeholder ETag. A later placeholder has a different nonce and ETag. After confirmed deletion and reservation drain the decision becomes `withdrawn`. A `published` decision has already drained its reservations and cleared its local bytes. Erasure leaves its anonymous shared artifact available for independent withdrawal.

Purge the User's previews, candidates and decision evidence with the User store only after the drain. Keep independent withdrawal markers outside the User's private prefix. These markers carry the sample ID alone as their locator.
