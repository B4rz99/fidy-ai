# Statement source work and review-record admission (#1130, #1140)

## Scope and source identity

The narrow change is a native Ingestion admission check for evidence actually destined for
`statement_needs_review`. It does not change portable parser acceptance, persist parsed artifacts,
add permissions, deploy anything, or bound total isolate memory. Accepted Transactions do not retain
raw evidence and remain accepted even when their unused evidence would exceed D1's row ceiling.

- Production and fix branch base: `62263a39cd36e571b49d2416d0772f6f6eb9248f`.
- Initial bounded characterization: parser PR #1143 head
  `cb944a9222e34ca73d3766e1a1abb9e95ba22cd5`. Processing is identical at these two revisions.
- Fix branch: `fix/1140-statement-evidence-row-budget`. This is separate from #1143; its published
  branch and CSV admission changes remain untouched.
- Five initial characterization tests passed locally: three portable tests (0.735 s) and two
  native source-IO tests (5.65 s). The earlier full-preflight prototype passed 35 native tests including a temporary first-activity
  probe (14.83 s); it was subsequently rejected on CPU-scaling evidence. Those results are not a
  substitute for final per-insert-patch validation, recorded below.
- A rejected full-document preflight prototype is retained in the measurement history below. The
  final patch removes that pass and keeps only per-review-insert admission.

## Confirmed work multipliers

`cloudflare/ingestion/internal/statement-processing.ts` reads, hashes and parses the entire source
before each 32-row activity, schema-decodes every row, then aggregates existing outcomes twice.
`statement-staging.ts` performs a HEAD and GET and verifies the digest again. At 20,000 rows and
5 MiB input this means 625 source reads, 3.05 GiB of logical bytes, 12.5 million row-schema visits
and approximately 12.5 million outcome-row visits. These are calculations from source, not observed
production CPU, resident memory, latency or billing.

The real R2/D1 97-row fixture measured four HEAD/GET pairs and four times the input byte length,
with exactly 97 Transactions, attestations and outcomes. Another User and terminal replay performed
no source IO. Injecting one failure before a row commit and one lost response after a successful
commit measured five HEAD/GET pairs, retained the committed row and finished with the same 97
unique captures. The retry policy allows two retries with one-minute exponential delay; the
original 24-hour retention deadline still limits total execution.

XLSX ZIP validation inflates the archive before SheetJS inflates it again. Existing dimensions and
ZIP expansion limits do not bound repeated shared-string text. Parsed fields, cell values and
formatted text can each reference the same string; JSON serialization repeats each occurrence.

## Complete D1 record budget

[D1's published ceiling](https://developers.cloudflare.com/d1/platform/limits/) is **2,000,000
decimal bytes**, for an individual string/BLOB or complete table row. It is not 2 MiB. SQLite applies
its [length limit](https://www.sqlite.org/limits.html) when encoding the complete record. Its
[record format](https://www.sqlite.org/fileformat2.html#record_format) defines the serial types,
integer payload widths and varint header lengths. Prepared SQL source length is a separate limit.

`statement-review-budget.ts` mirrors the 17 bound columns of `reviewStatement`:

1. Actual UTF-8 text lengths for metadata and identifiers; generated IDs are 36-byte UUIDs.
2. Exact JSON UTF-8 bytes for CSV/XLSX evidence and actual interpretation issues, including keys,
   punctuation, optional metadata, quotes, backslashes, control escapes, multibyte characters,
   surrogate pairs and escaped lone surrogates. No evidence is truncated or omitted.
3. `known_money` is NULL, as it is in the existing INSERT even when interpretation knows money.
4. INTEGER-affinity payload sizes and serial types: 0/1 use zero body bytes; other integers use
   1, 2, 3, 4, 6 or 8 bytes. Current epoch millisecond timestamps use 6 bytes each.
5. Record-header length, including serial-type varints and the header-length varint itself.

The string counter walks UTF-16 without allocating encoded strings or byte arrays. It saturates
above the ceiling. Small structural arrays are row-local; a single-review-check-local memo stores
string byte counts, charging every occurrence while avoiding repeated scans of shared strings.
There is no global or cross-User cache. The counter does not establish an aggregate-memory bound.

The independent boundary fixture uses 1,999,706 evidence bytes, 59 issue bytes, fixed UUIDs,
`mapping-unavailable`, record number 1, ordinary locale/revision metadata and two six-byte timestamps.
Its record header is 22 bytes and its complete record is 1,999,999 bytes. Adding one/two ASCII
spaces to the issue gives exactly 2,000,000/2,000,001. Tests compare the admission with an independent
JSON encoder and direct local D1 INSERTs for admitted rows. A separate native probe accepted
2,000,001-byte and 2,097,154-byte modeled records as well: the local emulator does **not** enforce
the documented ceiling at these sizes. The production admission follows the published limit; the
native probe establishes compatibility of admitted records, not production limit enforcement.

An independent SQLite 3.53.1 probe explicitly set `SQLITE_LIMIT_LENGTH` to 2,000,000, inserted the
same bound values into the checked-in table definition, and inspected the serialized B-tree record.
It measured 1,999,999/2,000,000-byte records with a 22-byte header and rejected the extra byte.
Observed serial types include 9 for record number 1 (zero payload), 0 for NULL known-money,
5 for each timestamp (six bytes), 85 for each UUID, and 3,999,425 for the evidence text.
This validates the record model against actual SQLite storage without claiming production D1 access.

The pending representation is the largest retained representation. Existing capacity/expiry logic
may instead store NULL evidence with `expired`, whose status has the same seven-byte length.
Admission remains before the evidence bind, which would otherwise allocate an oversized string
regardless of which SQL CASE branch is taken. Ordinary review-cap and abandonment behavior stays
unchanged. One near-limit edge becomes deterministic rejection: a string below 2,000,000 bytes
whose full pending row exceeds the limit might previously fit only as expired NULL evidence when
the global cap was full. Admission does not depend on that transient cross-User capacity state.

## Per-row admission and partial capture

Each prospective needs-review insert checks its actual metadata before encoding or binding evidence.
Overflow becomes the existing terminal `resource-limit` reason through `markFailed`; the offending
row creates no review record or outcome. This applies equally to new queued submissions and those
already processing. There is no new whole-document interpretation pass, Core operation or cache.

Earlier valid Transactions, SourceAttestations and outcomes remain committed exactly as before.
A new queued mixed file can therefore contain partial captures when a later oversized review row
fails. The patch does not claim all-or-nothing submission admission or roll back prior captures.
The existing failure unit reports conserved counts, preserves a spent Free entitlement (or releases
an unconsumed reservation), acknowledges extraction work and schedules raw-source deletion.
Terminal replay does not reread the original source or repeatedly attempt the oversized D1 insert.

## Why full-document admission was rejected

A rejected local prototype added one full pure interpretation pass to the first queued activity. A bounded 20,000-row, 528,925-byte CSV comparison captured only 32 rows per run: existing-processing
first activity took 530.2 ms and queued admission took 1,079.5 ms, a 549.3 ms local wall-time
increase. This single emulator sample is not a production CPU or concurrency guarantee. Neither that prototype nor the final per-row guard fixes eager parser allocation, repeated
whole-file parsing, aggregate shared-string expansion or cumulative outcome scans.

The bounded follow-up confirmed a separate CPU work multiplier: full queued preflight normalizes
all rows while an older activity interpreted at most 32. A single large shared string padded with
whitespace can be scanned repeatedly even when its trimmed Counterparty is tiny and accepted.
Bounded probes used 100 and 1,000 rows, a 65,536-character shared value, differing valid amounts
and exactly four mapped headers. At 1,000 rows, pure first-32 interpretation took 4.19 ms versus
96.19 ms for all rows; native first activity took 512.16 ms when already processing versus
594.81 ms when queued. The 100-row native sample was noisy: 457.56 ms versus 428.88 ms. All runs
wrote only 32 captures. These are Bun-hosted adapter timings with local D1/R2, not production V8
CPU. The physical fixtures expanded to only 87,449/271,062 bytes.

The important extrapolation is work, not latency: a permitted 20,000-row workbook can reuse one
large string across all rows. Full preflight performs up to 625 times as many repeated normalizations
in its first activity as the old 32-row interpretation. A hypothetical 20 MiB padded shared value
would mean approximately 390.6 GiB of repeated character visits across 20,000 rows, before counting
other normalization. This large case was not generated or run. Existing source/ZIP/dimension caps
are not a bound on repeated interpretation work. Money conversion also needs consideration; a
trim-only memo does not by itself bound repeated BigDecimal decoding.

The final patch removes the full preflight. Bulk admission remains deferred until owner-correct
document-local reuse or a separately reviewed admission/staging design bounds this work. Reusing whole
outcomes by row identity is insufficient when amounts vary; native code must not duplicate core
interpretation semantics or alter evidence/provenance to obtain a cache hit.

## Bounded fixtures and acceptance tests

All workbooks are synthetic standard OOXML with fixed ZIP timestamps. They have no external links,
macros or personal information. The amplification-only shared strings contain `x`. The paired capture/review fixture uses a
whitespace-padded `Cafe` counterparty that normalizes to an ordinary canonical Counterparty.

| Fixture                              | ZIP bytes | Expanded package bytes | Data rows | Shared value length |
| ------------------------------------ | --------: | ---------------------: | --------: | ------------------: |
| shared-string-small.xlsx             |     2,258 |                 11,191 |         1 |               4,096 |
| shared-string-row-limit.xlsx         |     2,278 |                 23,479 |         1 |              16,384 |
| shared-string-total-limit.xlsx       |     7,594 |                 85,307 |        40 |               4,096 |
| shared-string-accepted.xlsx          |     3,601 |              1,209,495 |        34 |           1,200,004 |
| shared-string-review.xlsx            |     3,605 |              1,209,495 |        34 |           1,200,004 |
| shared-string-repeated-accepted.xlsx |    19,123 |                271,062 |     1,000 |              65,536 |

The first three portable characterization tests preserve parser behavior. Exact measured serialized
evidence is 530,315 bytes for the 2,258-byte small fixture and 2,103,179 bytes for the 2,278-byte
row-limit fixture. Both paired 3,601/3,605-byte fixtures produce exactly 2,400,514 evidence bytes.
The aggregate fixture measured exactly 31,457,280 referenced text bytes across fields, cell values
and formatted text without serializing the amplified document. It is not a heap measurement.

The paired native fixtures use the exact four mechanically mapped headers and have 33 valid records
followed by one whitespace-padded counterparty record. Original value and display evidence exceed
the storage budget while the trimmed canonical Counterparty is still `Cafe`. Changing only
its currency from COP to an unsupported COX makes it require review:

- Queued review fixture: first activity captures 32 valid rows; the second captures row 33 and
  settles the oversized review row as terminal resource-limit. Exactly 33 Transactions, attestations
  and outcomes remain, the spent entitlement remains spent, and replay performs no third source read.
- First-row oversized review: zero captures or outcomes, released unspent Free reservation, terminal
  resource-limit and no source reread on replay.
- Accepted fixture: 34 captures, exact original source hash and XLSX provenance, no review evidence.
- Already-processing review fixture: retains 33 committed captures and the spent entitlement,
  then fails terminally with no oversized review row and no source read on terminal replay.
- Below/at/above complete-row boundaries cover ASCII, UTF-8, all JSON escape forms, optional formula,
  display and number-format metadata, NULL known-money and actual issue bytes.

The focused processing fixture uses minimal real migrations; the queued terminal-failure test additionally
installs the real `0036_statement_whatsapp_documents.sql` migration and checks that the terminal
trigger marks original staging material for resumable deletion and acknowledges the outbox. This
does not prove an actual R2 sweep. Full integration gates cover the existing complete lifecycle.

## Final validation

All execution was local and serialized, with a repository-pinned frozen install and checked local
workspace aliases. No production load or deployment was performed.

- Two final oversized-review regression cases failed on production baseline before the guard.
  The emulator persisted evidence that exceeds the documented production limit; this is not a
  measured production failure. Both cases pass with terminal resource-limit settlement.
- Native processing, admission, ingestion lifecycle and staging: 106 tests passed (43.56 s).
- Portable Ingestion suite: 30 tests passed (4.91 s).
- After correcting test-only Effect codec diagnostics, touched native files passed 36 tests
  (14.36 s) and portable amplification assertions passed all 3 tests (0.661 s).
- Root `bun run lint`, `bun run lint:type-aware`, `bun run format:check` and `bun run typecheck`
  passed against the final per-insert source. Final review/publication retains the exact commit
  identity and gate logs; this document does not assert production deployment or CI success.

The bounded CPU comparison remains the rationale for removing full preflight, not a performance
claim about a feature included in this patch. No aggregate-memory or all-or-nothing submission
admission guarantee is introduced.

## Deferred durable parsing/staging and memory policy

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) give 128 MB per isolate,
shared by concurrent requests. A new aggregate cap needs measurements of object graphs, library
intermediates and concurrency; the existing 25 MiB ZIP expansion limit does not justify an invented
25 MiB serialized-output policy.

Reusable parsing needs an immutable same-User generation bound to original source hash, parser
revision and retention deadline, durable cleanup ownership before R2 writes, verified publication,
bounded chunk reads and atomic progress counters. Test crashes at every write/publication/commit/
deletion boundary. Retain existing cap, abandonment and privacy semantics. This larger work remains
open under #1130/#1140 and is not implemented by the review-record fix.

## Follow-up implementation of the remaining gaps

The follow-up replaces the deferred reusable-parsing design above with private D1 fragments.
This makes derived publication, owner checks, progress receipts and terminal cleanup transactional
within one store; it avoids a second R2 write/deletion protocol. The original upload stays in R2.
Normal processing reads and hashes that upload once. A partial interrupted materialization permits
one rebuild; a complete generation with a lost publication response is reused directly. Each later
activity loads at most 32 derived rows. Receipt counters replace repeated prefix COUNT queries.

The retained rows have a 16 MiB encoded JSON budget, measured before encoding, with at most 1,024
fragments of at most 512 KiB UTF-8 each. Headers have a separate 512 KiB budget. The manifest pins
User, source digest, parser revision, format and original expiry. Fragment hashes, order and row
numbers are verified before use. Terminal failure/completion and expiry cascade-delete the cache,
while preserving already committed Transactions and entitlement accounting.

XLSX now performs a value-only preflight before formatted parsing. The complete workbook's
referenced value, formula and number-format text is capped at 8 MiB. Existing date, display,
number-format and 1904-date provenance remains unchanged. The 7,594-byte shared-string fixture
that previously represented 31,457,280 referenced field/value/display bytes now fails closed before
formatted parsing. These are logical-data bounds; they do not claim measured peak isolate heap
or production CPU limits. Large previously accepted representations may now fail resource-limit.

D1 outage alerts use one bounded metadata claim in the existing private R2 staging bucket.
Conditional writes deduplicate concurrent checks; a stable identity and original release survive
ambiguous email delivery and restarts. Firing repeats have a 30-minute floor, retries wait five
minutes and attempts are capped at six per generation. Recovery sends once. Storage/provider waits
are bounded, and failed R2 claims cannot suppress ordinary alerts when D1 remains healthy.
Scheduled health also isolates failed D1 metrics reads so the independent route is reachable.
