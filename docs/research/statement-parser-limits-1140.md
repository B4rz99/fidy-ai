# Statement parser bounds: #1140

## Decision and scope

This change enforces CSV columns, logical records and aggregate cells as fields are emitted,
before the parser can accumulate a surplus record or Schema can traverse an oversized result.
The pinned `csv-parse` 7.0.3 implementation calls its documented `cast` callback before
`record.push(field)`. The callback preserves the original string exactly; it does not perform
numeric/date conversion. This keeps quoting, escaped quotes, delimiter recognition, blank-line
handling and physical evidence positions owned by the existing parser rather than duplicating
its grammar in a preflight lexer.

Delimiter detection retains the existing first-physical-line counts and semicolon/comma/tab tie
order with three counters. It no longer creates repeated arrays proportional to the number of
delimiters. The input-byte and physical-line ceilings remain unchanged. The first surplus field,
including in a header, returns `resource-limit`; a malformed field within the admitted dimensions
still returns `malformed-file`. Logical rows are also bounded when the final row has no newline.

No public interface, XLSX parsing, storage, ownership, provenance generation, workflow commit,
retention, migration or deployment configuration changes. Existing closed parser failures supply
observability; no new logging of uploaded data is introduced. Existing CRLF evidence positions
are deliberately preserved, including the upstream parser's line-count/raw-terminator behavior.

## Measurements

Synthetic local measurements compare base `612ed42a4f1f9a5c2851ce1857c74cb46e87a930`
with this change, using the same pinned Bun executable and public `parseStatementFile` operation.
Five sequential samples per case; input creation and explicit GC happen before timing. These are
local timings, not production p95, production memory peaks or billing measurements.

| Input                                       | Before, milliseconds | After, milliseconds |
| ------------------------------------------- | -------------------- | ------------------- |
| 256 KiB commas                              | 174–214              | 4.7–14.0            |
| 1 MiB commas                                | 668–796              | 17.0–23.0           |
| 5 MiB commas                                | 3,259–3,646          | 78.0–81.5           |
| 20,000 valid four-field rows, 620,028 bytes | 40.9–81.5            | 74.8–99.4           |
| 250,000 valid empty cells, 250,000 bytes    | 18.2–18.5            | 77.8–87.8           |

For 5 MiB commas, median rejection improves from 3,571 ms to 79 ms, approximately 45 times
faster. Incremental process RSS was 161–184 MiB before and 9–10 MiB after in this harness.
RSS is sampled process memory, not a peak-allocation measurement; Bun heap samples are not
reliable evidence of V8/Workerd usage.

The field callback has a measured valid-input cost: approximately 31 ms at the median for
20,000 ordinary rows and 65 ms for the maximum empty-cell fixture. The library constructs
field context, including raw-record context, for each callback. This is an explicit tradeoff
for exact parser-owned grammar and early limits. It does not solve repeated parsing below.

A separate real Workerd run bundles the actual document Worker and uses its existing inspector
profiling helper. Comma inputs of 256 KiB, 1 MiB and 5 MiB reject with HTTP 413/resource-limit at
13.8, 24.4 and 95.9 ms sampled CPU. After those requests, sampled retained isolate heap is
9.1, 11.7 and 17.1 MB respectively. These observations do not establish peak memory or concurrent
request capacity. Delimiter detection and UTF-8 decoding still scan the bounded source bytes;
only field/result allocation stops at the limit.

## Regression evidence

- Real public parser tests exercise all three 5 MiB delimiter-only variants, surplus header and
  data fields before a deliberately malformed tail, exact 200-column/250,000-cell acceptance,
  the first excess cell, and the 20,000-row limit without a trailing newline.
- Semantic cases cover BOM, LF/CR/CRLF, mixed line endings, raw evidence, multiline fields,
  escaped quotes, more than 200 quoted delimiters, empty fields/lines, ragged records, tie order,
  numeric-looking text and malformed quotes.
- A real bundled Workerd regression rejects all three maximal delimiter-only inputs and then
  successfully parses a quoted multiline statement in the same isolate.
- Existing CSV/XLSX parser tests and native staging/processing/ingestion tests remain passing.

Commands, from the repository root with the pinned Bun on PATH:

```sh
bun run --cwd apps/server test:email-interpretation
bun run --cwd apps/server test:cloudflare \
  cloudflare/ingestion/statement-processing.test.ts \
  cloudflare/ingestion/statement-staging.test.ts \
  cloudflare/ingestion/statement-ingestion.test.ts \
  cloudflare/documents/document-parsing-worker.test.ts \
  cloudflare/documents/document-parsing-limits.test.ts
bun run typecheck
bun run lint:type-aware
bun run --cwd apps/server lint:deps
bun run format:check
```

The focused suites have 34 ingestion tests and 102 Cloudflare tests. This is not a claim that
all repository verification groups, browser journeys or production deployment gates ran.

## Repeated parsing: separate design required

Issue #1140 remains open. Every 32-row processing activity still reads, hashes, parses and
Schema-decodes the entire source. At 20,000 rows this is 625 passes; a 5 MiB source implies
3.05 GiB of logical source reads before retries. Changing this safely crosses existing R2/D1
publication and retention boundaries, so this patch introduces neither a process-global cache
nor a partial durable cache.

The proposed follow-up stays inside native Ingestion ownership:

1. Claim a bounded materialization generation under the same User coordinator. Read the owned
   staged source once and verify its size/digest through the existing staging owner. Parse and
   validate it before any row outcome can commit.
2. Write private immutable derived row chunks containing the original `ParsedStatementRow`
   evidence. Bound each chunk by both row count and serialized bytes, and impose an aggregate
   derived-byte ceiling calibrated for JSON escaping and duplicated raw/field evidence. A
   32-row count alone is not a sufficient byte bound. Preserve all CSV and XLSX provenance.
3. Publish a D1 manifest only after all chunks are durably written and checked. Bind it to the
   stable User, submission, staging identity, source digest, parser revision, format, headers,
   total row count, chunk byte lengths/checksums and the original retention deadline. Object
   keys alone never authorize reads. Pin a published generation across retries/restarts;
   never silently reparse it with a changed revision.
4. Each subsequent activity validates owned manifest metadata and reads only its next bounded
   chunk. Keep the existing same-User live processing/expiry fences, sequential row commits,
   unique `(submission, record)` outcomes and exact final accounting. Workflow history and
   queue messages retain identities only, never financial rows or raw evidence.
5. Extend all terminal, abandonment, expiry, User-erasure and orphan-recovery paths to derived
   objects. R2 and D1 cannot commit atomically: generation-specific private keys, a durable
   publication fence, cleanup checkpoints and bounded orphan discovery must cover crashes
   before/after every object write, manifest commit, row commit and deletion. A stale worker
   must not resurrect expired or deleted material. Chunk retention must not extend the
   existing source/evidence purpose.

This needs a reviewed schema/lifecycle change and native D1/R2 restart tests. Acceptance should
prove one source read/parse per successful materialization, bounded recovery work, O(rows)
aggregate chunk reads/decoding, unchanged accepted/review facts, two-User isolation, digest and
revision substitution refusal, idempotent publication and complete erasure at every failure
boundary. Missing/corrupt derived data must fail closed or recover only through an explicit
same-source generation protocol, never silently reparse the whole file in every row activity.
