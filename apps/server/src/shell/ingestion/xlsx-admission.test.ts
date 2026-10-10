import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx/xlsx.mjs";
import type { WorkBook, WorkSheet } from "xlsx";
import { statementParserLimits } from "./contract";
import { parseStatementFile } from "./operations";

const writeWorkbook = (book: WorkBook): Uint8Array => {
  const fresh: WorkBook & { SSF: Record<number, string> } = {
    ...book,
    SSF: { 0: "General" },
  };
  const buffer: unknown = XLSX.write(fresh, {
    type: "array",
    compression: true,
    bookSST: true,
  });
  if (!(buffer instanceof ArrayBuffer)) throw new Error("Expected workbook bytes");
  return new Uint8Array(buffer);
};
const workbook = (text: string): Uint8Array => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["h"], ["normal"]]), "Statement");
  const source = writeWorkbook(book);
  return modify(source, (entries) =>
    replacePart(entries, "xl/sharedStrings.xml", (xml) =>
      xml.replace("<t>normal</t>", `<t>${text}</t>`)
    )
  );
};
const modify = (
  source: Uint8Array,
  update: (entries: Record<string, Uint8Array>) => void
): Uint8Array => {
  const entries = unzipSync(source);
  update(entries);
  return zipSync(entries);
};
const replacePart = (
  entries: Record<string, Uint8Array>,
  name: string,
  update: (text: string) => string
): void => {
  entries[name] = strToU8(update(strFromU8(entries[name] ?? new Uint8Array())));
};
const reject = (source: Uint8Array, reason = "resource-limit"): Effect.Effect<void> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(parseStatementFile(source));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.safeReason).toBe(reason);
  });

it.effect("admits the exact repeated-text work boundary and rejects its next byte", () =>
  Effect.gen(function* () {
    // Header h costs two bytes; shared index 1 costs one byte in addition to the value.
    const length = statementParserLimits.maximumReferencedTextBytes - 3;
    for (const adjustment of [-1, 0]) {
      const parsed = yield* parseStatementFile(workbook("x".repeat(length + adjustment)));
      expect(parsed.rows[0]?.fields[0]?.length).toBe(length + adjustment);
    }
    yield* reject(workbook("x".repeat(length + 1)));
  })
);

it.effect("bounds numeric text before shared and inline strings reach interpretation", () =>
  Effect.gen(function* () {
    const maximumDigits = 128;
    const parsed = yield* parseStatementFile(workbook("1".repeat(maximumDigits)));
    expect(parsed.rows[0]?.fields[0]).toBe("1".repeat(maximumDigits));
    yield* reject(workbook("1".repeat(maximumDigits + 1)));
    yield* reject(workbook("_x0031_".repeat(maximumDigits + 1)));
    yield* reject(workbook("1".repeat(maximumDigits + 1) + "masked"));
    const source = workbook("normal");
    yield* reject(
      modify(source, (entries) =>
        replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
          xml.replace(
            '<c r="A2" t="s"><v>1</v></c>',
            `<c r="A2" t="inlineStr"><is><t>${"1".repeat(maximumDigits + 1)}</t></is></c>`
          )
        )
      )
    );
  })
);

it.effect("rejects ambiguous shared-string indexing and namespace attributes", () =>
  Effect.gen(function* () {
    const source = workbook("normal");
    yield* reject(
      modify(source, (entries) =>
        replacePart(entries, "xl/sharedStrings.xml", (xml) =>
          xml.replace("<si>", '<si unexpected="yes">')
        )
      ),
      "malformed-file"
    );
    yield* reject(
      modify(source, (entries) =>
        replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
          xml.replace('t="s"', 'xmlns:bad="urn:bad" bad:t="s"')
        )
      ),
      "malformed-file"
    );
  })
);

it.effect("refuses foreign attribute aliases for shared values, styles and formulas", () =>
  Effect.gen(function* () {
    const source = workbook("x".repeat(140000));
    for (const attribute of ["T", "t_extra"]) {
      yield* reject(
        modify(source, (entries) =>
          replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
            xml.replace(/t="s"/gu, `${attribute}="s"`)
          )
        ),
        "malformed-file"
      );
    }
    for (const attribute of ["S", "s_extra"]) {
      yield* reject(
        modify(source, (entries) =>
          replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
            xml.replace('<c r="A2"', `<c ${attribute}="0" r="A2"`)
          )
        ),
        "malformed-file"
      );
    }
    for (const attribute of ["T", "t_extra"]) {
      yield* reject(
        modify(source, (entries) =>
          replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
            xml.replace("<v>1</v>", `<f ${attribute}="shared" si="0">A1</f><v>1</v>`)
          )
        ),
        "malformed-file"
      );
    }
    for (const attribute of ["NumFmtId", "numFmtId_extra", "FormatCode", "formatCode_extra"]) {
      yield* reject(
        modify(source, (entries) =>
          replacePart(entries, "xl/styles.xml", (xml) =>
            xml.replace(
              "</styleSheet>",
              `<numFmts><numFmt ${attribute}="164"/></numFmts></styleSheet>`
            )
          )
        ),
        "malformed-file"
      );
    }
  })
);

it.effect("rejects binary workbook parts despite unrelated admitted XML", () =>
  Effect.gen(function* () {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["h"], ...Array.from({ length: 10 }, () => ["x".repeat(32700)])]),
      "Statement"
    );
    const buffer: unknown = XLSX.write(book, {
      type: "array",
      bookType: "xlsb",
      compression: true,
      bookSST: true,
    });
    if (!(buffer instanceof ArrayBuffer)) throw new Error("Expected workbook bytes");
    yield* reject(
      modify(new Uint8Array(buffer), (entries) => {
        entries["decoy.xml"] = strToU8("<worksheet/>");
      })
    );
    // An XML-labelled binary part must not select the suffix-based binary parser either.
    yield* reject(
      modify(workbook("normal"), (entries) =>
        replacePart(entries, "[Content_Types].xml", (xml) =>
          xml.replace(
            'PartName="/xl/worksheets/sheet1.xml"',
            'PartName="/xl/worksheets/sheet1.bin"'
          )
        )
      )
    );
    yield* reject(
      modify(workbook("normal"), (entries) =>
        replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
          xml.replace(/worksheet/gu, "decoy")
        )
      ),
      "malformed-file"
    );
  })
);

it.effect(
  "bounds custom format code and shared-formula translation before workbook construction",
  () =>
    Effect.gen(function* () {
      const book = XLSX.utils.book_new();
      const sheet: WorkSheet = XLSX.utils.aoa_to_sheet([["h"], [1]]);
      sheet.A2 = { t: "n", v: 1, z: `0"${"x".repeat(256)}"` };
      XLSX.utils.book_append_sheet(book, sheet, "Statement");
      yield* reject(writeWorkbook(book));
      yield* reject(
        modify(workbook("normal"), (entries) =>
          replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
            xml.replace("<v>1</v>", '<f t="shared" si="0">A1</f><v>1</v>')
          )
        )
      );
    })
);

it.effect("rejects formula translation triggers hidden inside unrelated attributes", () =>
  Effect.gen(function* () {
    for (const type of ["shared", "array"]) {
      yield* reject(
        modify(workbook("normal"), (entries) =>
          replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
            xml.replace("<v>1</v>", `<f desc='t="${type}"' ref="A2:A3" si="0">1+1</f><v>1</v>`)
          )
        )
      );
    }
  })
);

it.effect("rejects repeated worksheet targets and excess workbook sheet references", () =>
  Effect.gen(function* () {
    const source = workbook("normal");
    yield* reject(
      modify(source, (entries) =>
        replacePart(entries, "xl/workbook.xml", (xml) =>
          xml.replace("</sheets>", '<sheet name="Alias" sheetId="2" r:id="rId1"/></sheets>')
        )
      ),
      "malformed-file"
    );
    yield* reject(
      modify(source, (entries) => {
        replacePart(entries, "xl/workbook.xml", (xml) =>
          xml.replace("</sheets>", '<sheet name="Alias" sheetId="2" r:id="alias"/></sheets>')
        );
        replacePart(entries, "xl/_rels/workbook.xml.rels", (xml) =>
          xml.replace(
            "</Relationships>",
            '<Relationship Id="alias" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>'
          )
        );
      }),
      "malformed-file"
    );
    const sheetTags = Array.from(
      { length: 21 },
      (_, index) =>
        `<sheet name="Sheet${index}" sheetId="${index + 1}" r:id="${index === 0 ? "rId1" : `extra${index + 1}`}"/>`
    ).join("");
    const relationshipTags = Array.from(
      { length: 20 },
      (_, index) =>
        `<Relationship Id="extra${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 2}.xml"/>`
    ).join("");
    yield* reject(
      modify(source, (entries) => {
        replacePart(entries, "xl/workbook.xml", (xml) =>
          xml.replace(/<sheets>[\s\S]*?<\/sheets>/u, `<sheets>${sheetTags}</sheets>`)
        );
        for (let index = 2; index <= 21; index += 1) {
          entries[`xl/worksheets/sheet${index}.xml`] =
            entries["xl/worksheets/sheet1.xml"] ?? new Uint8Array();
        }
        replacePart(entries, "xl/_rels/workbook.xml.rels", (xml) =>
          xml.replace("</Relationships>", relationshipTags + "</Relationships>")
        );
      })
    );
  })
);

it.effect("counts actual expanded archive bytes at the boundary before workbook construction", () =>
  Effect.gen(function* () {
    const source = workbook("normal");
    const entries = unzipSync(source);
    const contentBytes = Object.values(entries).reduce((sum, entry) => sum + entry.length, 0);
    const padding = statementParserLimits.maximumExpandedBytes - contentBytes;
    for (const extra of [-1, 0]) {
      const archive = modify(source, (parts) => {
        parts["padding.bin"] = new Uint8Array(padding + extra);
      });
      expect((yield* parseStatementFile(archive)).rows).toHaveLength(1);
    }
    yield* reject(
      modify(source, (parts) => {
        parts["padding.bin"] = new Uint8Array(padding + 1);
      })
    );
  })
);

it.effect("admits 100000 XLSX cells and rejects the first surplus cell", () =>
  Effect.gen(function* () {
    const columns = 200;
    const rows = 500;
    const book = XLSX.utils.book_new();
    const data = Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => "normal")
    );
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), "Statement");
    const source = writeWorkbook(book);
    expect((yield* parseStatementFile(source)).rows).toHaveLength(rows - 1);
    yield* reject(
      modify(source, (entries) =>
        replacePart(entries, "xl/worksheets/sheet1.xml", (xml) =>
          xml.replace(
            "</sheetData>",
            '<row r="501"><c r="A501" t="s"><v>0</v></c></row></sheetData>'
          )
        )
      )
    );
  })
);

it.effect(
  "refuses XML constructs whose foreign regex interpretation can disagree with admission",
  () =>
    Effect.gen(function* () {
      for (const markup of [
        "<!-- <si><t>hidden</t></si> -->",
        "<?hidden <si><t>hidden</t></si> ?>",
        "<![CDATA[<si><t>hidden</t></si>]]>",
      ]) {
        yield* reject(
          modify(workbook("normal"), (entries) =>
            replacePart(entries, "xl/sharedStrings.xml", (xml) =>
              xml.replace("</sst>", `${markup}</sst>`)
            )
          ),
          "malformed-file"
        );
      }
      yield* reject(
        modify(workbook("normal"), (entries) =>
          replacePart(entries, "xl/styles.xml", (xml) =>
            xml.replace(
              "</styleSheet>",
              '<cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>'
            )
          )
        ),
        "malformed-file"
      );
    })
);
