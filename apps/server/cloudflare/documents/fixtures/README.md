# Document parsing proof fixtures

These fixtures are test evidence only and are not production inputs.

## Generated in this repository

- `valid-document.pdf` is a one-page PDF containing “Fidy document parsing proof”. It was created with the pinned `mupdf@1.28.1` `PDFDocument`, `Font`, `addPage`, and `saveToBuffer("compress")` APIs.
- `protected-document.pdf` was derived from `valid-document.pdf` with the same pinned MuPDF package using `saveToBuffer("compress,encrypt=aes-256,user-password=proof-password")`.
- `valid-image.png` is a locally generated 256×128 RGB checkerboard. It uses only the PNG signature, IHDR, zlib-compressed IDAT, and IEND chunks; it contains no third-party artwork.

The malformed, oversized, expansion, dimension, and near-limit fixtures are generated in the focused tests or `scripts/document-parsing/check.ts` so their hostile properties remain visible beside their assertions.

## Apache POI test corpus

The following genuine Office structures are vendored from the Apache POI test corpus under the Apache License 2.0:

- `SimpleMacro.xlsm` — VBA project fixture, pinned at [`f5091846ffac98632ea67aa9cab7d94c4c2bf2a6`](https://github.com/apache/poi/blob/f5091846ffac98632ea67aa9cab7d94c4c2bf2a6/test-data/spreadsheet/SimpleMacro.xlsm).
- `link-external-workbook-a.xlsx` — external workbook relationship fixture, pinned at [`bd1ea63abe44de41d9cb90f4457bc1b939a7f1c1`](https://github.com/apache/poi/blob/bd1ea63abe44de41d9cb90f4457bc1b939a7f1c1/test-data/spreadsheet/link-external-workbook-a.xlsx).

See the [Apache POI license](https://github.com/apache/poi/blob/trunk/LICENSE.txt).
