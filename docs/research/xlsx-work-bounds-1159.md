# XLSX work admission (#1159)

## Reproduce

From the repository root, with the pinned Bun and installed workspace dependencies:

```sh
bun scripts/document-parsing/xlsx-work.ts --baseline > before.jsonl
bun scripts/document-parsing/xlsx-work.ts > after.jsonl
```

The script builds the unbound document proof Worker, starts local workerd, and executes `parseStatementFile`, evidence serialization, and the real `interpretStatementRows` seam with the native 32-row chunk size. It returns only counts, sizes, closed rejection reasons and timings. No financial text is emitted. Each run owns and cleans up its temporary Worker and HTTP connections. Baseline swaps only the parser module from commit `6ecbe8efbd33f0fc462f629823bddc641bad2e74`; the proof interpreter and schemas stay identical. All measured packages are below both the old and current expansion ceilings. Baseline mode requires that commit in local Git history.

The committed [observations](xlsx-work-bounds-1159.json) record local workerd 1.20261001.1, Wrangler 4.144.0, SheetJS 0.20.3, Bun 1.4.3-canary.1, compatibility date 2026-09-08 and a 30,000 ms configured CPU ceiling. CI uses the repository lockfile; these local observations do not assert identical runner versions or timings.

## Observations

ZIP bytes are upload size. Expanded bytes are the sum of actual decompressed package members. Logical text counts field values, evidence values and formatted evidence references, even when they share the same JavaScript string. Serialized evidence is the sum of individually encoded `StatementRowEvidence` UTF-8 JSON records. Neither logical text nor serialized size is retained heap. A complete D1 review record additionally contains issues and metadata.

| Fixture                         | ZIP bytes | Expanded bytes | Logical text bytes | Serialized evidence bytes | Interpreted rows | Outcome  | Sampled active V8 ms |
| ------------------------------- | --------: | -------------: | -----------------: | ------------------------: | ---------------: | -------- | -------------------: |
| shared-string-small             |      2258 |          11191 |             786432 |                    530315 |                0 | parsed   |                 11.7 |
| shared-string-row-limit         |      2278 |          23479 |            3145728 |                   2103179 |                0 | parsed   |                 10.1 |
| shared-string-total-limit       |      7594 |          85307 |                  — |                         — |                — | rejected |                 10.0 |
| shared-string-accepted          |      3601 |        1209495 |            3602013 |                   2417418 |               34 | parsed   |                 32.9 |
| shared-string-review            |      3605 |        1209495 |            3602013 |                   2417418 |               34 | parsed   |                 39.8 |
| shared-string-repeated-accepted |     19123 |         271062 |                  — |                         — |                — | rejected |                 19.4 |
| different-amounts               |     54421 |         178647 |           12335679 |                   8702266 |             1000 | parsed   |                297.0 |
| escaped-formatted               |     15778 |          44139 |            1186236 |                   1638806 |              128 | parsed   |                 64.8 |
| formatted-work-outside-envelope |     33117 |         103767 |                  — |                         — |                — | rejected |                 13.7 |
| numeric-outside-envelope        |      5978 |          15512 |                  — |                         — |                — | rejected |                  4.0 |
| many-cells                      |   1695716 |        7357998 |                  — |                         — |                — | rejected |                888.2 |
| bounded-cells                   |    676645 |        2835958 |            1112148 |                  10679080 |                0 | parsed   |               1190.1 |

The 1,000-row financial fixture shares a 4,096-byte value with leading whitespace while each Amount differs. All 1,000 rows are accepted by the real interpreter. The 34-row long-text fixture retains its 1,200,004-byte Counterparty source and produces 34 accepted outcomes; its COX variant produces 33 accepted and one review outcome. This exercises repeated trim work and distinct Amount decoding without relying on cross-document memoization. The escaped fixture repeats quotes, backslashes and newlines, has custom formatted evidence, and produces 128 review outcomes. Its serialized evidence exceeds its logical text.

Before admission moved ahead of workbook construction, aggregate repetition was rejected only after library materialization. The baseline shared-string-total-limit and repeated-accepted cases already returned resource-limit; the new boundary rejects those before `XLSX.read`. The formatted-work-outside-envelope and 129-digit Amount cases previously reached interpretation and now return resource-limit. The formatted case is deliberately conservative: actual output is small for that particular format, but the policy charges the full possible token work.

| Fixture                         | Baseline sampled active V8 ms | Current sampled active V8 ms | Baseline post-request heap bytes | Current post-request heap bytes |
| ------------------------------- | ----------------------------: | ---------------------------: | -------------------------------: | ------------------------------: |
| shared-string-total-limit       |                          97.4 |                         10.0 |                         11917836 |                        13183460 |
| shared-string-repeated-accepted |                         146.2 |                         19.4 |                         23465392 |                        26531304 |
| formatted-work-outside-envelope |                          54.9 |                         13.7 |                         27161468 |                        26268456 |
| many-cells                      |                        1596.9 |                        888.2 |                         98730592 |                        29579852 |
| bounded-cells                   |                         628.7 |                       1190.1 |                         75044816 |                        54311700 |

## Selected admission policy

- Upload: the existing 5 MiB provider-decoded ceiling.
- ZIP: at most 1,000 members and 12 MiB of actual aggregate expanded data. Deflate is fed in 1 KiB compressed chunks and checks output before retaining it. ZIP64, encryption, ambiguous duplicate names, mismatched local names/methods/flags, and unsafe paths are refused. The admitted members are rebuilt as one stored ZIP so SheetJS cannot follow different local-size or ZIP64 metadata.
- Work: at most 8 MiB charged across every worksheet cell, including headers and hidden sheets. Column-style ranges are bounded to 200 columns and charge their repeated attribute bytes plus a 64-byte object allowance before foreign expansion. A cell costs its decoded inline text plus referenced shared-string bytes, plus `(valueBytes + 64) * customFormatBytes`. The 64-byte allowance covers bounded numeric formatting; a 256-byte format ceiling limits token scans and literals. Custom format IDs above 392 are refused because SheetJS remaps them into other IDs. This is a conservative work policy, not the number of allocated bytes.
- Objects and interpretation: at most 100,000 combined actual XLSX cells and expanded column-style slots before SheetJS, and 100,000 aggregate rectangular cells before evidence construction. Existing 200-column, 20,000-data-row and 20-sheet limits remain. Text with more than 128 decimal digits (including Office escapes and rich-text source) is conservatively refused in shared, inline and scalar values before repeated BigDecimal decoding. All cells are checked because mapping may be unavailable at parse time.
- XML: no DTD, CDATA, comments, processing instructions or nested markup inside text leaves; ambiguous shared-string indexing and duplicate format sections/IDs are refused. Cost-bearing namespace, capitalization and underscore attribute aliases are refused, matching SheetJS's attribute interpretation. Cells, string items and formats must occur in their admitted XML representations. Workbook sheet references are capped before construction and must resolve to distinct admitted worksheet parts; repeated relationship targets are refused. Binary financial parts (including disguised XLSB packages and binary part targets) are outside the envelope; inert VBA attachments remain supported. Shared and array formula translation is outside the envelope; ordinary inert formula evidence remains supported.
- Reuse: native materialization revision is now statement-material-v2. Earlier generations fail closed before another capture, with partial receipts preserved, so previously materialized rows cannot bypass this policy. No whole-document interpretation preflight or new interpretation cache is introduced.

The cell cap follows the high-object fixture: 240,012 cells and only about 7 MiB of XML produced a post-request heap sample near 94 MiB before this change. The current policy refuses that shape before foreign cell objects are built. A 96,012-cell fixture remains admitted. The 12 MiB package cap reduces the allowance for simultaneously retained decoded members, UTF-16 XML, canonical ZIP bytes and SheetJS intermediates; it replaces the previous 25 MiB package policy. The 8 MiB work charge retains both long-text semantic fixtures while refusing aggregate repetition and conservatively expensive formatting. A 128-digit per-value ceiling bounds arbitrary-precision conversion independently of repeated byte scans.

Two overlapping 1,000-row financial requests and two overlapping 96,012-cell requests were exercised in the same local isolate. Their observations are in the JSON record. V8 runs synchronous parsing sequentially; asynchronous native D1 work can retain documents across awaits, so these samples are not a bound on every concurrent production schedule. Limits apply per document, not as an isolate-wide memory reservation.

## Verification and limits

Public parser tests exercise work below/at/above 8 MiB, expanded data below/at/above 12 MiB, exactly 100,000 cells and its first surplus cell, 128/129-digit shared and inline values, custom formatting, shared-formula exclusion, forged ZIP metadata and ambiguous XML. Existing financial values, dates, hidden-sheet provenance, formulas and original evidence tests remain. Native tests prove aggregate rejection has no captures, attestations, review rows or derived parts; releases an unspent Free reservation; marks staging for cleanup; and replays without reading source again. Older-generation and oversized-review tests preserve partial captures and consumed entitlement. The independent 2,000,000-byte complete D1 review-record boundary remains tested below/at/above its limit.

Inspector CPU is sampled non-idle V8 time, not an authoritative production billed-CPU measurement. Handler elapsed time includes serialization and scheduling. Heap readings are pre/post-request `Runtime.getHeapUsage` samples; they miss transient peaks, external buffers and overall workerd memory. Garbage collection and other host activity affect all observations. The configured local CPU ceiling is not proof of production enforcement. No allocation-peak, universal OOM-safety, maximum-concurrency or production-latency guarantee follows from this experiment.

Source checks: installed SheetJS `parse_zip`/`parse_local_file` for ZIP interpretation, `parse_sst_xml` for shared references, `parse_ws_xml_data` for cell/formula intermediates and `safe_format` for formatted strings. [SheetJS parse options](https://docs.sheetjs.com/docs/api/parse-options/) and [cell objects](https://docs.sheetjs.com/docs/csf/cell/) describe retained value, formatted text, format and formula evidence. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) state that 128 MiB applies per isolate across concurrent requests.
