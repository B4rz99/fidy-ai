# Forwarded email is untrusted financial evidence

- **Status:** Accepted
- **Date:** 2026-08-28

A permanent unpredictable forwarding address associates an authenticated Cloudflare Email Worker
admission with one User; it does not authenticate the sender or make email content a User command.
The Email Worker and its R2 handoff provide bounded, provider-neutral evidence to the application.
The application may interpret that hostile evidence into a canonical Transaction with immutable
source provenance, or create a NeedsReviewItem when interpretation is unsafe.

Forwarded email grants no caller scope, agent tool authority, payment authority, or destructive side
effect. Provider proof, metadata, bounded content retrieval, attachment handling, and model results
are validated independently. The source provider identity is `cloudflare-email`; outbound Resend
remains unrelated delivery infrastructure.

Requiring sender enrollment or User confirmation for every interpreted Transaction was rejected
because notification forwarding is itself the product's ingestion act and Transactions are editable
financial records, not instructions to move money. Treating email as trusted was also rejected:
platform admission establishes delivery integrity only, while provenance and review preserve the
uncertainty of the evidence.
