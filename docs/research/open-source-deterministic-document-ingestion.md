# Open-source deterministic document ingestion for Fidy

_Research snapshot: 2026-08-11. Scope: local/open-source components for Fidy issues #18–#22, with emphasis on loss-accountable CSV/XLSX statement ingestion._

## Correction: anydoc is open source

**Yes: `firecrawl/anydoc` itself is open source.** The Rust crate and its Node, Python, and WASM bindings are published under the MIT license. Its open-source implementation runs locally and describes itself as having no ML models or external service calls. [anydoc package and license](https://github.com/firecrawl/anydoc/blob/4e3089b1ed43404241a303109f81e2c7933040b2/Cargo.toml#L6-L18) · [anydoc features](https://github.com/firecrawl/anydoc/blob/4e3089b1ed43404241a303109f81e2c7933040b2/README.md#L128-L137)

**Firecrawl Parse is different.** `/parse` is Firecrawl's hosted API, with optional OCR and schema-shaped LLM extraction. Fidy does not need to use that service in order to use anydoc. [Firecrawl Parse documentation](https://docs.firecrawl.dev/features/parse) · [Parse API](https://docs.firecrawl.dev/api-reference/endpoint/parse)

The previous report's recommendation was about anydoc's **data contract**, not its license: it optimizes for readable document conversion and partial recovery, while issue #18 requires every statement line to remain accounted for as either a Transaction or a NeedsReviewItem. [Fidy #18](https://github.com/B4rz99/fidy-ai/issues/18) · [detailed anydoc evaluation](./anydoc-for-fidy-ingestion.md)

## Executive recommendation

For #18, build Fidy's deterministic statement adapter from open-source parser primitives:

- **CSV:** [`csv-parse`](https://csv.js.org/parse/) (MIT), configured to retain each raw logical record and position metadata.
- **XLSX:** spike [`SheetJS Community Edition`](https://docs.sheetjs.com/) (Apache-2.0) first because its cell model can retain the underlying value, formatted text, number format, formula, address, and workbook metadata. Use the direct cell model—not `sheet_to_json`, CSV, or Markdown. [`ExcelJS`](https://github.com/exceljs/exceljs) (MIT) is the npm-native alternative if SheetJS's official-CDN distribution is unacceptable.
- **Fidy-owned code:** bank-format profiles, header matching, statement-table boundaries, row accounting, exact date/Money interpretation, SourceAttestation locators, NeedsReview conversion, and canonical decoding.

This is deterministic without building CSV or OOXML decoding from scratch. **Deterministic does not mean dependency-free**; it means the same captured bytes, parser/profile revisions, and interpretation context produce the same result without an agent deciding row by row.

The one mapping model call currently required by #18 can also be removed, but that would be a specification change. Replace it with deterministic matching for known profiles plus a one-time user/admin mapping screen for unknown formats. A model may remain an optional proposal mechanism, never the authority.

## Maintenance check

The choices are not equally clear-cut:

- **`csv-parse`: yes—an actively maintained, strong default.** Version 7.0.2 was published on 2026-08-02 and the upstream repository was updated on 2026-08-05. Its focused API also exposes the raw-record and position information Fidy needs. [npm package](https://www.npmjs.com/package/csv-parse/v/7.0.2) · [upstream repository](https://github.com/adaltas/node-csv) · [`raw`](https://csv.js.org/parse/options/raw/) · [`info`](https://csv.js.org/parse/options/info/)
- **SheetJS CE: best feature fit in the Bun/TypeScript shortlist, but only a provisional choice.** Its source repository is active—the latest source commit in this snapshot is 2026-02-09—but its latest tagged release remains 0.20.3 from 2024-07-18. The official Bun guide calls Bun support experimental, recommends vendoring, and distributes the package from SheetJS's CDN rather than npm. [latest source commit](https://git.sheetjs.com/sheetjs/sheetjs/commit/d2f2e179636be22f3af3c306df7783ea10a2c7e3) · [v0.20.3 tag](https://git.sheetjs.com/sheetjs/sheetjs/src/tag/v0.20.3) · [official Bun guide](https://docs.sheetjs.com/docs/getting-started/installation/bun/)
- **ExcelJS is not the better-maintained fallback.** Its latest release is 4.4.0 from 2023-10-19, although the repository is not archived. [ExcelJS releases](https://github.com/exceljs/exceljs/releases/tag/v4.4.0) · [repository](https://github.com/exceljs/exceljs)
- **`read-excel-file` is more actively released**—9.3.10 was published on 2026-08-10—but its convenience model intentionally trims strings by default, drops trailing empty rows, returns formula cached values without formulas, and silently turns missing/error formula results into empty cells. Those transformations make it a poorer fit for #18's evidence and conservation requirements despite good maintenance. [npm package](https://www.npmjs.com/package/read-excel-file/v/9.3.10) · [official README](https://gitlab.com/catamphetamine/read-excel-file/-/blob/master/README.md)
- **Calamine is actively maintained**—0.36.1 was released on 2026-07-27—and is the Rust decoder beneath anydoc, but using it directly would require Fidy to own a Rust/N-API boundary and still design the missing evidence model. [Calamine v0.36.1](https://github.com/tafia/calamine/releases/tag/v0.36.1) · [anydoc dependency](https://github.com/firecrawl/anydoc/blob/4e3089b1ed43404241a303109f81e2c7933040b2/Cargo.toml#L24-L33)

**Conclusion:** adopt `csv-parse` confidently. Do not adopt SheetJS merely from this paper comparison; run the bank-fixture and hostile-file spike first. SheetJS CE currently remains the leading pure TypeScript candidate because its evidence-rich cell model fits #18 better than the more recently published convenience parser, not because it has the cleanest release story.

## What should be built versus reused

### Reuse format decoders; build the financial adapter

```text
untrusted bytes
  -> content identification and resource limits
  -> open-source format decoder
  -> evidence-preserving source units
  -> deterministic bank-format profile
  -> canonical Transaction/Money decode
  -> Transaction + SourceAttestation | NeedsReviewItem
```

The reusable decoder should answer only “what records/cells/text items are in these bytes?” Fidy's adapter should answer “which units are statement rows, what do their fields mean, and where is the immutable evidence?” This keeps third-party parser models out of the domain and preserves Fidy's canonical decode gate. [Fidy server architecture](../../apps/server/ARCHITECTURE.md) · [Fidy #18](https://github.com/B4rz99/fidy-ai/issues/18)

### Do not implement CSV or XLSX syntax from scratch

CSV has deceptively difficult record boundaries: quoted fields may contain commas, quotes, CRLF, and therefore physical newlines. RFC 4180 defines escaped quotes and multi-line fields. A malformed unmatched quote can make the intended next record unknowable; no parser can always recover the author's intent. [RFC 4180 §2](https://www.rfc-editor.org/rfc/rfc4180#section-2)

XLSX is an Office Open XML ZIP package with workbook relationships, worksheets, shared/inline strings, styles and number formats, date systems, sparse addresses, formulas and cached results, merged cells, hidden state, and other metadata. ECMA-376 specifies the format in multiple parts. Reimplementing enough of it safely would create a second spreadsheet library rather than Fidy domain value. [ECMA-376 specification](https://ecma-international.org/publications-and-standards/standards/ecma-376/) · [SheetJS cell model](https://docs.sheetjs.com/docs/csf/cell/)

Building Fidy's strict accounting layer from scratch **is** appropriate. Building archive, XML, formula, encoding, and CSV quoting machinery is not.

## Recommended components

| Source                | Open-source component                                                                                                                                        | License                                                                              | What it deterministically provides                                                                                                                                                                                                                                                                  | Important limit                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CSV                   | [`csv-parse`](https://csv.js.org/parse/)                                                                                                                     | MIT                                                                                  | Streaming records, original raw record text, byte/line/record info, strict errors and bounded record size. [`raw`](https://csv.js.org/parse/options/raw/) · [`info`](https://csv.js.org/parse/options/info/) · [errors](https://csv.js.org/parse/errors/)                                           | Recovery after malformed quoting is inherently ambiguous; fail closed rather than silently skipping.                                                                                                                     |
| XLSX                  | [SheetJS CE](https://docs.sheetjs.com/)                                                                                                                      | Apache-2.0 ([license](https://docs.sheetjs.com/docs/miscellany/license/))            | Cell address/type, underlying `v`, formatted `w`, number format `z`, formula `f`, styles, sheet metadata, hidden state. [cell objects](https://docs.sheetjs.com/docs/csf/cell/) · [read options](https://docs.sheetjs.com/docs/api/parse-options/)                                                  | Current releases are distributed from SheetJS's CDN, not the stale npm `xlsx` package; pin and checksum an official tarball. [official installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) |
| XLSX alternative      | [ExcelJS](https://github.com/exceljs/exceljs)                                                                                                                | MIT ([license](https://github.com/exceljs/exceljs/blob/master/LICENSE))              | Workbook/sheet/row/cell APIs, source addresses, types, formulas/cached results, `numFmt`, hidden rows/columns, and iteration including empty rows. [official README](https://github.com/exceljs/exceljs/blob/master/README.md)                                                                      | Latest tagged release is 4.4.0 and its read-side `cell.text` should not be assumed to reproduce Excel's formatted display; preserve `value` and `numFmt` separately and verify fixtures.                                 |
| Text PDF              | [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) / [PDF.js](https://github.com/mozilla/pdf.js)                                                       | Apache-2.0 ([license](https://github.com/mozilla/pdf.js/blob/master/LICENSE))        | In-memory PDF loading, password input, pages, text items, transforms, dimensions, and strict-error mode. [loading parameters](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) · [`getTextContent`](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)   | Text items are not statement rows or tables. Fidy must reconstruct layout deterministically for known profiles or review/fallback.                                                                                       |
| PDF table experiments | [pdfplumber](https://github.com/jsvine/pdfplumber), [Camelot](https://github.com/camelot-dev/camelot), or [Tabula](https://github.com/tabulapdf/tabula-java) | MIT                                                                                  | Coordinate-aware text/table extraction for machine-generated PDFs; visual/debug tooling or explicit extraction methods.                                                                                                                                                                             | Python/JVM sidecars add operational weight; table heuristics still need fixture proof and do not handle image-only scans by themselves.                                                                                  |
| Scans/images          | [Tesseract OCR](https://github.com/tesseract-ocr/tesseract)                                                                                                  | Apache-2.0 ([license](https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE)) | Local OCR with UTF-8, 100+ languages, image input, and text/hOCR/TSV/ALTO outputs. TSV/hOCR include word positions and confidence-like scores. [capabilities](https://github.com/tesseract-ocr/tesseract#about) · [TSV/hOCR usage](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html) | Tesseract uses an LSTM neural recognizer. It avoids a hosted vision agent but is not a purely symbolic parser and can misread Money. Every result still needs canonical validation/review.                               |
| Scanned PDFs          | [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF)                                                                                                             | MPL-2.0 ([license](https://github.com/ocrmypdf/OCRmyPDF/blob/main/LICENSE))          | Local PDF raster/OCR pipeline using Tesseract, searchable text layers, and optional sidecar text. [introduction](https://ocrmypdf.readthedocs.io/en/stable/introduction.html) · [sidecars](https://ocrmypdf.readthedocs.io/en/stable/cookbook.html#produce-pdf-and-text-file-containing-ocr-text)   | CLI/Python system dependencies and rewritten PDFs. Preserve Fidy's original bytes as evidence; treat OCR output as derived.                                                                                              |
| Email                 | [`postal-mime`](https://github.com/postalsys/postal-mime)                                                                                                    | MIT-0 ([license](https://github.com/postalsys/postal-mime/blob/master/LICENSE.txt))  | RFC822/MIME parsing into headers, text, HTML, recipients, and attachments; TypeScript, no dependencies, explicit nesting/header limits. [official README](https://github.com/postalsys/postal-mime#readme)                                                                                          | It parses the envelope/content but does not infer financial events; #22's observed bank regex/profile layer is still needed.                                                                                             |
| Generic office text   | [anydoc](https://github.com/firecrawl/anydoc) or [Apache Tika](https://tika.apache.org/)                                                                     | MIT / Apache-2.0                                                                     | Broad local extraction from office formats; Tika also handles PDF and mail formats. [anydoc formats](https://github.com/firecrawl/anydoc/blob/4e3089b1ed43404241a303109f81e2c7933040b2/README.md#L139-L150) · [Tika formats](https://tika.apache.org/3.3.1/formats.html)                            | Good for search/context, not Fidy's financial-row evidence contract. Tika also introduces a JVM service.                                                                                                                 |

## Exact design for #18

### 1. Capture an evidence-preserving source model

A useful shell-level intermediate is closer to this than to Markdown:

```text
StatementSource
  contentHash
  detectedFormat
  parserRevision
  units[]
    locator
      CSV: logicalRecord, startLine, endLine, byte range
      XLSX: sheetName, sheetIndex, rowNumber, cell addresses
    rawEvidence
      CSV: exact raw logical record
      XLSX: cells[] { address, type, value, formattedText, numberFormat, formula }
    visibility
    diagnostics[]
  accounting
    structuralUnits
    candidateRows
    malformedUnits
```

This is a conclusion from #18's SourceAttestation and “nothing silently discarded” requirements. The intermediate belongs in the shell because it represents parser-specific evidence, not canonical domain state. [Fidy #18](https://github.com/B4rz99/fidy-ai/issues/18) · [Fidy server architecture](../../apps/server/ARCHITECTURE.md)

The issue currently says “input line count = accepted Transactions + NeedsReviewItems,” but does not define how headers, blank lines, footers, or XLSX sheet rows count. Before implementation, refine it to an executable invariant such as:

```text
discovered units = structural units + candidate data rows + malformed units
candidate data rows + malformed units = accepted Transactions + NeedsReviewItems
```

Alternatively, require each bank profile to define which source units are data rows. Without this clarification, a valid header already makes the literal acceptance criterion impossible.

### 2. CSV adapter

Use `csv-parse` with a pinned dialect/profile and approximately these policies:

- `raw: true` and `info: true` to retain source record text and parser position;
- no `columns` conversion at the evidence boundary—duplicate or blank headers must not erase cells;
- explicit encoding, delimiter, quote, escape, and record delimiter once a bank profile is selected;
- a bounded `max_record_size` plus upload/record limits;
- strict errors by default;
- no `skip_records_with_error` for generic CSV.

The parser documents that skipped-record recovery is unsafe when quoted fields may contain record delimiters because, after an error, the parser cannot know whether a newline belongs inside a field. [skip-record warning](https://csv.js.org/parse/options/skip_records_with_error/)

Safe policy:

1. For a known bank profile that forbids multiline fields, a malformed physical line can become one NeedsReviewItem with exact raw evidence.
2. For a generic/unknown CSV with ambiguous quoting, fail the file closed into review instead of importing a possibly shifted suffix. Do not silently accept rows after the ambiguity.

Delimiter detection can be deterministic: parse a bounded prefix under candidate delimiters and choose only when one candidate has a uniquely consistent field count and matches a known header profile. Otherwise request mapping/review.

### 3. XLSX adapter

Prefer a SheetJS CE fixture spike with direct worksheet/cell access and explicit options:

```text
cellFormula: true
cellNF: true
cellStyles: true
cellText: true
cellDates: false
sheetStubs: true
nodim: true
WTF: true
bookVBA: false
```

The official read-options documentation states that `WTF: false` suppresses worksheet parse errors by default, `cellNF` retains number formats, `cellText` retains formatted text, `cellStyles` enables row/column metadata, `sheetStubs` retains blank stub cells, and `nodim` calculates ranges from actual cells rather than trusting the declared range. [SheetJS read options](https://docs.sheetjs.com/docs/api/parse-options/)

Important rules:

- Iterate cell addresses directly; do not call a JSON/CSV/Markdown convenience converter before evidence capture.
- Preserve sheet name/index and visibility, row/column hidden state, cell address, raw value, formatted text, number format, and formula/cached result.
- Never evaluate workbook formulas, macros, external links, or active content.
- Treat formula-only values without an acceptable cached/display result as NeedsReview.
- Interpret date serials and monetary numbers only under the selected bank profile. Preserve the original value and format regardless.
- Bound archive bytes, worksheets, expanded cells, strings, and processing time; XLSX is hostile ZIP/XML input.

SheetJS's official docs show separate properties for underlying value (`v`), displayed/formatted text (`w`), number format (`z`), and formula (`f`). They also document hidden and very-hidden worksheet metadata. [cell model](https://docs.sheetjs.com/docs/csf/cell/) · [sheet visibility](https://docs.sheetjs.com/docs/csf/features/visibility/)

If installing a dependency from SheetJS's official CDN conflicts with Fidy's supply-chain policy, run the same fixtures against ExcelJS. Do not choose based on feature lists alone.

### 4. Deterministic bank-format profiles

A bank-format profile can remove row-level AI and, if desired, all AI:

```text
BankStatementProfile
  fingerprintRevision
  sourceFormat
  workbook/sheet predicates
  header aliases
  table-start/table-end rules
  column roles
  date formats
  decimal/group separators
  debit/credit/sign rules
  currency rule
  ignorable structural row predicates
```

Selection flow:

1. Normalize headers mechanically: Unicode NFKC, case fold, trim/collapse whitespace, and profile-defined punctuation/accent handling.
2. Fingerprint the detected source format, normalized headers, column count, sheet hints, and stable issuer markers.
3. Select only a unique profile.
4. Validate the entire candidate table under that profile before committing any row effects.
5. Unknown or ambiguous format goes to one-time mapping/review.
6. Save the confirmed mapping as a versioned profile; re-use it deterministically.

There are three policy choices:

- **Current #18:** one small model call proposes the profile mapping; canonical validation and row handling remain deterministic.
- **Zero-model option:** a user/admin maps columns once in a small UI. Known profiles need no model call.
- **Hybrid:** deterministic aliases first, model proposal only for unknown headers, and human confirmation when ambiguous.

The zero-model and hybrid options require changing #18's acceptance criterion that one model call occurs per format. They do not require changing the canonical Transaction/Money gate or NeedsReview model.

## Deterministic processing for adjacent sources

### Text-based PDFs (#20)

Use PDF.js directly before any vision call:

1. Load captured `Uint8Array` and an optional transient password. PDF.js supports both `data` and `password` parameters and can reject rather than recover from selected parse errors with `stopAtErrors`. [PDF.js loading API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
2. Extract each page's text items and transforms with `getTextContent`; retain page number, string, transform, width, and height as evidence locators. [PDF page API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
3. For a known statement profile, cluster items into lines by Y tolerance and assign columns by configured X bands/header anchors.
4. Validate reconstructed rows through the same canonical gate.
5. If text is absent, layout is unknown, or conservation checks fail, use local OCR, the existing layout-aware model path, or NeedsReview.

This can eliminate vision for known text PDFs. It cannot make arbitrary PDF tables unambiguous: PDF often stores positioned glyphs, not semantic table rows.

### Scanned PDFs, receipts, and screenshots (#21)

There is no symbolic parser that can recover text not encoded in the file. The choices are:

- manual review;
- local OCR such as Tesseract; or
- a hosted/local vision model.

Tesseract avoids sending financial images to another provider and can emit TSV/hOCR word boxes for deterministic downstream rules. It still performs learned OCR and may confuse decimal separators, thousands separators, digits, or currency marks. Money must never be accepted on OCR confidence alone; canonical decoding, consistency checks, and NeedsReview remain the authority. [Tesseract capabilities](https://github.com/tesseract-ocr/tesseract#about) · [Fidy #21](https://github.com/B4rz99/fidy-ai/issues/21)

For scanned PDFs, OCRmyPDF can orchestrate image extraction and Tesseract, but Fidy should retain the original PDF and preferably use a sidecar/derived artifact rather than treating the rewritten PDF as original evidence. [OCRmyPDF introduction](https://ocrmypdf.readthedocs.io/en/stable/introduction.html)

### Emails (#22)

Use PostalMime to turn raw RFC822 bytes into bounded MIME parts, then apply bank-specific observed regex/profile rules to normalized text. Attachments re-enter the appropriate source adapter. This follows #22's deterministic-fast-path/model-fallback design while keeping MIME complexity out of Fidy code. [PostalMime README](https://github.com/postalsys/postal-mime#readme) · [Fidy #22](https://github.com/B4rz99/fidy-ai/issues/22)

## Security requirements for every option

All uploaded files are hostile under Fidy's security standard. [Hostile ingestion material](../../SECURITY_STANDARDS.md#7-hostile-ingestion-material)

At minimum:

- identify content from bytes, not filename or declared MIME;
- bound compressed input and expanded archive/XML/image/page/row/cell/text sizes;
- apply parser time and memory budgets, ideally with worker/process isolation for native, Python, or JVM tools;
- use strict/fail-closed parser modes where available;
- never execute formulas, macros, embedded scripts, external references, hyperlinks, or attachment names;
- keep protected-PDF passwords and plaintext transient and out of logs/errors;
- retain only the bounded original evidence required by Fidy's retention policy;
- decode all parser output at the trust boundary—the library's TypeScript type is not trust;
- record parser/profile revisions so later resolution uses captured interpretation context;
- commit domain effects only after whole-file accounting has passed, preventing malformed suffixes from creating partial state.

These controls follow Fidy's validation, privacy, hostile-ingestion, and log/error invariants. [Fidy security standards](../../SECURITY_STANDARDS.md)

## Local Bun compatibility spike

A local throwaway spike used Bun 1.3.14 on macOS arm64. No project dependencies were changed.

| Package                         | Version tested | Result                                                                                                                                 |
| ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@firecrawl/anydoc`             | 0.1.8          | Imported and parsed in-memory CSV successfully.                                                                                        |
| `csv-parse`                     | 7.0.2          | Imported successfully.                                                                                                                 |
| `exceljs`                       | 4.4.0          | Imported; XLSX write/read round trip retained addresses, values, formula/cached result, number formats, and hidden-row state.          |
| `xlsx` official SheetJS tarball | 0.20.3         | Imported; round trip exposed cell `v`, `w`, and `z`.                                                                                   |
| `postal-mime`                   | 3.0.0          | Imported successfully.                                                                                                                 |
| `pdfjs-dist`                    | 6.2.108        | Top-level browser-oriented import failed because `DOMMatrix` was unavailable; `pdfjs-dist/legacy/build/pdf.mjs` imported successfully. |

One malformed anydoc CSV fixture with an unmatched quote did not fail: it combined the following physical line into the quoted field. This is a valid demonstration of the generic CSV ambiguity described by `csv-parse`'s skip-error warning, and reinforces the fail-closed/profile-specific policy. It is not a benchmark of either library.

These smoke tests prove only module/API feasibility on one development host. Production Bun bundling, Linux image behavior, hostile-file limits, performance, and extraction accuracy require repository fixtures and acceptance tests.

## Proposed decision and implementation sequence

1. **Clarify #18's counting invariant** for headers, blank lines, footers, malformed logical records, sheets, and hidden rows.
2. **Create anonymized fixtures** from each supported Colombian bank: CSV dialects, XLSX styles, debit/credit layouts, dates, COP amounts, formulas, hidden rows, malformed records, and decoy/header/footer lines.
3. **Prototype `csv-parse` and SheetJS CE behind one Fidy-owned statement-source interface.** Use direct evidence APIs and strict settings.
4. **Run ExcelJS against the same XLSX fixtures** if the official-CDN dependency path is undesirable.
5. **Implement versioned bank profiles and row conservation.** No row effects commit unless accounting passes.
6. **Choose mapping policy explicitly:** retain #18's one model proposal, replace it with manual one-time mapping, or use deterministic-first hybrid matching.
7. **For #20, separately spike PDF.js** on text-based statement fixtures before changing the native layout-aware model decision.
8. **For image-only sources, evaluate local Tesseract only as OCR evidence**, not as trusted Money extraction.

## Decision

**Fidy can build this locally and deterministically without a hosted document-processing service and without an agent looking at every row.** The best architecture is not one universal converter. It is:

- mature open-source format decoders;
- a small Fidy-owned, evidence-preserving adapter per source kind;
- versioned deterministic bank profiles;
- exact canonical validation;
- complete accounting into Transaction or NeedsReviewItem;
- optional model/OCR fallback only where the source is unknown or contains pixels rather than text.

For #18 specifically, start with **`csv-parse` + SheetJS CE + Fidy bank profiles**. Keep anydoc available for generic office-to-text use or as a comparison fixture, not as the row-accounting boundary.

## Unresolved questions

- How should #18 define “input line” for CSV headers/multiline records and XLSX blank, hidden, header, and footer rows?
- Is an official-CDN tarball dependency acceptable under Fidy's dependency policy, or should Fidy choose npm-published ExcelJS or pin/vendor SheetJS with a verified digest?
- Which Colombian banks and export variants define the initial supported profile set?
- For an unknown bank format, should Fidy retain the required model proposal, ask the User to map columns, or require an admin-reviewed profile?
- What whole-file size, decompression, worksheet, row, cell, page, and OCR limits should the Ingestion operation enforce?
- Do representative text PDFs retain enough coordinates in PDF.js to justify a deterministic #20 fast path?
