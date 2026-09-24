# Worker document-parsing proof

_Proof snapshot: 2026-09-22. Issue: [#697](https://github.com/B4rz99/fidy-ai/issues/697). Runtime pins: Wrangler 4.131.2, compatibility date `2026-09-08`, Workers types 5.20260915.1, SheetJS CE 0.20.3, csv-parse 7.0.2, and MuPDF 1.28.1._

## Decision

CSV and XLSX statement decoding stay in a Worker. The checked proof bundles and starts the real parser in local workerd, streams the request into a 5 MiB compressed-input ceiling, enforces the parser's 25 MiB XLSX expansion ceiling, and exercises a maximum-row CSV plus a 20,000-row, 240,012-cell XLSX input near both admitted ceilings. It needs no filesystem, Bun API, native addon, binding, or outbound connection. `node:zlib` is a supported Workers runtime API at the pinned compatibility date rather than a Bun/native fallback.

Ordinary PDF and image extraction do **not** justify a Container. `document-extraction-worker.ts` is a non-routable Worker-native proof that streams at most 5 MiB, selects PDF or PNG from bytes rather than claims, rejects encrypted PDFs, enforces 10,000-pixel sides and 40-megapixel PNGs, invokes Workers AI exactly once per request, rejects Markdown above 1 MiB, and returns no document text. The executable gate converts the checked PDF and PNG through the remote binding under workerd and records upload, startup, active CPU, retained heap, compatibility, and hostile-input evidence. Focused tests assert the one-call connection bound. Workers AI exposes neither a documented PDF page-count option, a streamed conversion result, nor an abort signal. Therefore the 1 MiB ceiling is post-materialization and caller cancellation stops awaiting and exposing output but cannot cancel provider work. These are exact binding capability limits, not hidden guarantees; this candidate remains non-routable and does not authorize PDF/image ingestion until the provider supplies pre-materialization output and cancellation controls.

Protected-PDF decryption is the one conditional Container exception. The pinned official MuPDF WASM package bundles to JavaScript, but workerd fails during startup in Emscripten glue at `node:module.createRequire` before loading the WASM module. `bun run check:document-parsing` reproduces that failure and fails if the candidate begins to start, so the exception must be removed and re-evaluated when the package/runtime changes.

## Executable evidence

Run:

```sh
bun run check:document-parsing
bun run --cwd infra/cloudflare check:document-parsing:remote # authenticated evidence
(cd apps/server && bun --bun vitest run src/shell/ingestion/parser.test.ts --coverage.enabled=false)
bun --bun vitest run apps/server/cloudflare/documents/document-parsing-worker.test.ts apps/server/cloudflare/documents/document-extraction-worker.test.ts
```

The deterministic build gate runs the first command. It validates every local bundle, startup, statement-runtime, hostile-fixture, and protected-document assertion without requiring repository secrets. The explicitly selected authenticated command additionally starts the Workers AI binding and records the remote PDF/image runtime evidence. Together they perform these checks against the proof configurations:

1. `wrangler deploy --dry-run` builds the production-like module Worker; the gate parses Wrangler's reported uncompressed upload size and enforces the 64 MiB ceiling.
2. `wrangler check startup` runs the bundle under workerd and enforces the 1,000 ms startup ceiling.
3. `wrangler dev` runs the same entry and compatibility date under workerd.
4. A 20,000-row CSV and a 20,000-row, 240,012-cell XLSX workbook complete beneath the configured 30,000 ms paid-Worker CPU ceiling. Handler elapsed time includes streamed body collection and is a conservative local bound for this synchronous single-isolate work, not an edge CPU meter.
5. both maximum-row formats complete under workerd's isolate memory ceiling; the inspector additionally reports retained heap below 128 MiB after both. Retained heap is not presented as peak heap.
6. Wrangler must report no bindings, and the Worker test spies on global `fetch` to prove the parser path makes no subrequest. The path therefore consumes none of the six simultaneous outgoing-connection allowance.
7. the Workers AI proof's upload and startup remain below the same pinned limits, and Wrangler reports exactly its one AI binding.
8. the authenticated gate converts the checked valid PDF and PNG through the remote Workers AI binding under workerd despite deliberately mismatched `content-type` claims; inspector profiles record CPU and retained heap.
9. the authenticated gate runs unknown bytes, a truncated PDF, excessive PNG dimensions, malformed image data rejected by the provider, and an encrypted PDF through the extraction workerd.
10. focused public-seam tests additionally prove declared and streamed input exhaustion, post-materialization output rejection, provider failure redaction, byte-based selection, exactly one binding invocation, and that caller cancellation returns without exposing provider output.
11. malformed CSV, forged XLSX expansion, oversized worksheet dimensions, and an XLSM containing VBA plus an external formula execute through workerd, not only the Bun test runtime.
12. the pinned MuPDF proof bundle is built separately and must fail workerd startup with the recorded `createRequire` incompatibility.

A representative run on macOS arm64 produced:

| Measurement                               |                        Result |                                      Constraint |
| ----------------------------------------- | ----------------------------: | ----------------------------------------------: |
| Wrangler-reported statement Worker upload |               1,775,576 bytes |                                67,108,864 bytes |
| local startup profile window              |                     84.753 ms |                                        1,000 ms |
| 20,000-row CSV sampled active CPU         |                    154.363 ms |                                       30,000 ms |
| near-limit XLSX sampled active CPU        |                   1,722.52 ms |                                       30,000 ms |
| retained heap after CSV and XLSX          |              87,128,200 bytes |                               134,217,728 bytes |
| retained heap growth                      |              79,292,224 bytes |                               134,217,728 bytes |
| statement binding/subrequest evidence     |                          none |                                               6 |
| Workers AI extraction upload              |                 426,650 bytes |                                67,108,864 bytes |
| Workers AI extraction startup             |                     44.241 ms |                                        1,000 ms |
| PDF/image sampled active CPU              |              2.679 / 1.588 ms |                                       30,000 ms |
| extraction retained heap / growth         |     3,122,932 / 588,684 bytes |                               134,217,728 bytes |
| extraction connection evidence            | 1 binding invocation asserted |                                               6 |
| MuPDF proof bundle                        |                 147,901 bytes | bundle succeeds, startup fails before WASM load |

The request CPU values are active V8 samples from the workerd inspector with idle samples excluded; they are local regression measurements, not edge-hardware predictions. Cloudflare's deployment validation and runtime enforcement remain authoritative for startup and peak isolate memory. The gate validates pinned limits, runs the admitted work in workerd, and records post-request pre-forced-GC heap in addition to successful completion under the runtime ceiling.

## Hostile fixtures and outcomes

| Threat                                                                  | Executable evidence                                   | Outcome                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| malformed CSV / invalid UTF-8 / ambiguous quote                         | `parser.test.ts`                                      | closed `malformed-file`; no rows returned                                                                            |
| mismatched MIME/type claim                                              | `document-parsing-worker.test.ts`, workerd proof      | bytes select CSV; claim cannot select a parser                                                                       |
| oversized body and CSV record/row/cell counts                           | both suites                                           | streaming stops at the boundary or parser returns `resource-limit`                                                   |
| forged ZIP sizes, unsupported compression, truncated offsets, expansion | `parser.test.ts`, workerd gate                        | rejected before SheetJS                                                                                              |
| oversized worksheet dimensions, rows, columns, cells, sheets            | `parser.test.ts`, workerd gate                        | `resource-limit`                                                                                                     |
| formulas and external workbook relationships                            | parser tests, Apache POI fixture, workerd gate        | retained as inert evidence, never evaluated or fetched                                                               |
| VBA macro project                                                       | Apache POI `SimpleMacro.xlsm`, workerd gate           | workbook data is read; VBA bytes are never exposed or executed                                                       |
| cancellation                                                            | `document-parsing-worker.test.ts`                     | in-flight body collection is interrupted and its stream cancelled; bounded synchronous parsing has no partial effect |
| valid PDF and image                                                     | checked fixtures, remote-binding workerd gate         | bounded Workers AI conversion succeeds without returning extracted content                                           |
| mismatched PDF/image type claims                                        | unit test and remote-binding workerd gate             | byte signatures select the converter                                                                                 |
| malformed/unknown PDF and image bytes                                   | unit test and remote-binding workerd gate             | rejected before conversion or closed `conversion-failed` from Workers AI                                             |
| image dimensions                                                        | unit test and workerd gate                            | sides over 10,000 pixels or images over 40 megapixels fail before conversion                                         |
| declared/streamed input and converted-output expansion                  | extraction Worker tests                               | input collection stops at 5 MiB; full provider string is rejected after 1 MiB, exposing the non-streaming API limit  |
| cancellation during collection or Workers AI conversion                 | Worker public-seam tests                              | returns closed `cancelled` with no output; binding has no signal to cancel provider work                             |
| PDF/protected PDF                                                       | encrypted fixture, extraction unit test, workerd gate | ordinary PDF converts; encrypted PDF is isolated as `password-required` before AI                                    |
| protected-document password                                             | workerd probe and MuPDF startup proof                 | the pinned candidate fails before decryption; the password is not returned, logged, or stored                        |

The checked `SimpleMacro.xlsm` and `link-external-workbook-a.xlsx` fixtures come from pinned revisions of Apache POI's Apache-2.0 test corpus and contain genuine VBA-project and OOXML external-link structures rather than synthetic marker bytes. The PDF, protected PDF, and PNG are locally generated without third-party artwork. Exact provenance and generation details are recorded in `infra/cloudflare/fixtures/README.md`.

The XLSX parser is intentionally whole-file and memory-bounded, not streaming. Its 5 MiB compressed, 25 MiB expanded, 1,000-entry, 20-sheet, 20,000-row, 200-column, and 250,000-cell ceilings are the admitted envelope. A future increase requires rerunning the heap and CPU proof; it is not a configuration-only change.

## Protected-document Container eligibility (not deployment approval)

The MuPDF startup failure makes protected-PDF decryption eligible for the only Container exception. No Container deployment or callable interface is approved by this proof. Before protected PDF support can be enabled, a separate review must approve a private Core Worker interface, authorization tests, and the concrete adapter. That future Container may implement only:

```text
bounded encrypted PDF bytes + transient password
  -> authenticate/decrypt in memory
  -> bounded decrypted PDF bytes | closed safe failure
```

The Container is stateless and provider-isolated:

- no D1, R2, Queue, Workflow, Workers AI, Kapso, Wompi, Resend, or public route binding;
- no persistent volume, cache, log body, crash dump, shell input, caller filename, or password retention;
- no general outbound network access;
- invoked only by a private Core Worker service-binding interface that has passed separate architecture and security review after subject authorization and bounded R2 retrieval;
- receives one bounded byte stream and password, clears temporary files/memory on every outcome, and returns only bounded bytes plus a closed failure code;
- never creates Transactions, SourceAttestations, NeedsReviewItems, AuditLogEntries, or any other authoritative state;
- cancellation terminates the isolated work and deletes all temporary material.

Core remains responsible for authorization, User isolation, retention, canonical decoding, audit, and authoritative state. The measured runtime failure authorizes eligibility for this narrow exception; it does not approve a Container resource, Worker interface, adapter, or production route in the current Alchemy stack.

## Pinned platform constraints

Cloudflare documents 128 MiB isolate memory, a 64 MiB uncompressed Worker size, one-second startup, six simultaneous outgoing connections, and paid HTTP CPU configurable up to five minutes (30 seconds by default). The proof pins 30 seconds rather than raising the default. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Cloudflare documents `node:zlib` as native Workers support and enables Node compatibility by default for compatibility dates on or after 2026-08-04. See [`node:zlib`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/). Workers AI documents PDF and common image formats as supported conversion inputs. The proof enforces Fidy-owned input-byte and PNG-dimension limits and checks output size, one-call behavior, and caller cancellation; the binding does not expose streamed output, provider cancellation, or a PDF page-count option. See [supported conversion formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/) and [conversion options](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/).
