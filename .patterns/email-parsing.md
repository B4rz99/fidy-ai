# Email MIME parsing

Use for forwarded Email admission, queued reprocessing, and retained original material.
Selected source is the integrity-locked `postal-mime@4.2.0` package:
`node_modules/postal-mime/src/{postal-mime,mime-node,types}.ts` and its published ESM build.
Import `PostalMime` from `postal-mime`; the package owns its build paths and type declarations.

## Bound hostile input before parsing

The native Email Worker refuses new deliveries while operational institution verification and
Connection admission are unavailable. The retained receipt/storage path resolves only an approved
envelope recipient and collects at most 1 MiB of raw bytes. Those storage checks do not establish
institution admission. MIME From/To headers, display names and the parsed OTP-Token header do not establish User
identity, mailbox verification, or permission to execute Work. Parser errors remain closed refusals;
raw input, parser messages and financial content never enter diagnostics.

Admission and queued processing both supply these parser limits:

```ts
PostalMime.parse(bytes, {
  maxHeadersSize: 16_384,
  maxNestingDepth: 8,
  maxRfc822NestingDepth: 0,
});
```

The header budget is shared across MIME parts, and each header line costs at least 64 bytes.
This prevents many short headers or many individually small parts from bypassing the budget.
The upstream part-count limit also bounds wide messages. With inline RFC822 parsing disabled,
forwarded messages remain attachments and follow the owner's existing attachment refusal.

Queued processing verifies the retained raw-byte digest and repeats MIME validation. An earlier
successful admission does not authorize changed bytes or attachment processing. Retain the raw
message bytes as evidence; decoded text and HTML are projections, not replacements for the original.

## Parsed fields remain untrusted

Version 3 changed duplicate single-value headers to first-wins, retained unfolded header whitespace,
and restored document order for recipient fields. Callers use structured fields, not raw header
whitespace. Address groups remain distinct from individual mailboxes. Version 4 widened attachment
disposition types to the actual supplied token; reject attachments by their presence, not by a
trusted filename, disposition or MIME claim.

HTML is decoded but not sanitized. Retained original material is a bounded, no-store, browser-owner
read; never serve the original as active HTML or disclose it to another User or an agent.

## Test seam

[Forwarded Email integration tests](../apps/server/cloudflare/ingestion/forwarded-email.test.ts)
exercise the real parser with native D1/R2: encoded multipart capture and replay, exact raw evidence,
legacy charset decoding, original-material User isolation, aggregate header limits, and plain or
transfer-encoded RFC822 attachment refusal. The Email interpretation suite separately checks
canonical extraction and unsupported-content behavior.
