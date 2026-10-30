# Poppins assets

The five `*-Latin.woff2` faces are derived from the adjacent original WOFF2 files.
`index.css` selects these subsets for Latin text and keeps each original face as
fallback for the remaining scripts. The font family, weights, and `font-display`
behavior are unchanged. Each subset contains 349 code points and is about 12.5 KB,
compared with about 51 KB for the original face.

The original [SIL Open Font License](Poppins-OFL.txt) applies. Copyright and license
metadata are retained inside every subset. No Reserved Font Name is designated
by this copy of the license.

To regenerate from the repository root, use a temporary environment:

```sh
python3 -m venv /tmp/fidy-poppins-tools
/tmp/fidy-poppins-tools/bin/pip install fonttools==4.60.1 brotli==1.2.1
/tmp/fidy-poppins-tools/bin/python apps/web/scripts/subset-poppins.py
```

The script checks the selected character map against the originals and verifies
every retained glyph outline and advance, vertical metrics, and copyright/license
name records. It does not change CSS. FontTools can update the font modification
timestamp, so byte-for-byte hashes are not the glyph-equivalence check.

The selected ranges are `U+0000-024F,U+0300-036F,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2212,U+2215,U+FEFF,U+FFFD`.
FontTools and Brotli are generation tools, with no application runtime dependency.
