import { Option } from "effect";
import { SaxesParser, type SaxesTagPlain } from "saxes";
import { StatementParseFailed, statementParserLimits } from "~/shell/ingestion/contract";
import { decodeXlsxArchive, encodeXlsxArchive } from "./xlsx-archive";

const maximumCells = statementParserLimits.maximumXlsxCells;
const maximumSheets = 20;
const maximumFormatBytes = 256;
const maximumNumericDigits = 128;
const numericFormattingAllowance = 64;
const xmlChunkCharacters = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const limit = (): never => {
  throw new StatementParseFailed({ safeReason: "resource-limit" });
};
const malformed = (): never => {
  throw new StatementParseFailed({ safeReason: "malformed-file" });
};
const localName = (name: string): string => name.split(":").at(-1) ?? name;
const size = (text: string): number => encoder.encode(text).length;
const indexFor = (source: string): number => {
  if (!/^\d+$/u.test(source)) return malformed();
  const index = Number(source);
  return Number.isSafeInteger(index) ? index : malformed();
};

const scan = (xml: string, configure: (parser: SaxesParser) => void): void => {
  const parser = new SaxesParser();
  parser.on("doctype", malformed);
  configure(parser);
  for (let start = 0; start < xml.length; start += xmlChunkCharacters) {
    parser.write(xml.slice(start, start + xmlChunkCharacters));
  }
  parser.close();
};

const assertNumericText = (text: string): void => {
  // SheetJS decodes Office escapes after XML entities. Count conservatively even when
  // rich-text/phonetic markup would remove nonnumeric characters from the eventual value.
  const decoded = text.replace(/_x([\da-f]{4})_/giu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  if (decoded.replace(/\D/gu, "").length > maximumNumericDigits) limit();
};
const assertAttributes = (tag: SaxesTagPlain): void => {
  const canonical = [
    "t",
    "s",
    "numFmtId",
    "formatCode",
    "si",
    "ContentType",
    "PartName",
    "Target",
    "Type",
  ];
  for (const name of Object.keys(tag.attributes)) {
    if (name.startsWith("xmlns:")) continue;
    // SheetJS lowercases attribute aliases and strips underscore suffixes. Refuse
    // spellings that would make its cost-bearing attributes differ from this scan.
    const alias = localName(name).split("_")[0]?.toLowerCase();
    const expected = canonical.find((attribute) => attribute.toLowerCase() === alias);
    if (expected !== undefined && name !== expected) malformed();
  }
};

const requiredXmlRoots: Readonly<Record<string, string>> = {
  c: "worksheet",
  f: "worksheet",
  si: "sst",
  sstItem: "sst",
  xf: "styleSheet",
  numFmt: "styleSheet",
};
const assertContentType = (tag: SaxesTagPlain): void => {
  const contentType = tag.attributes.ContentType ?? "";
  const binaryFinancialType =
    /^application\/vnd\.ms-excel\.(?:sheet\.binary\.macroEnabled\.main|worksheet|chartsheet|macrosheet|dialogsheet|sharedStrings|styles|comments|sheetMetadata|calcChain)$/u;
  if (binaryFinancialType.test(contentType)) limit();
  if ((tag.attributes.PartName ?? "").endsWith(".bin") && contentType.endsWith("+xml")) {
    limit();
  }
};
const assertRelationship = (tag: SaxesTagPlain): void => {
  if (
    (tag.attributes.Target ?? "").endsWith(".bin") &&
    /\/(?:worksheet|chartsheet|dialogsheet|macrosheet|officeDocument|styles|sharedStrings)$/u.test(
      tag.attributes.Type ?? ""
    )
  ) {
    limit();
  }
};
const assertXmlRepresentation = (tag: SaxesTagPlain, root: string): void => {
  const name = localName(tag.name);
  const requiredRoot = requiredXmlRoots[name];
  if (requiredRoot !== undefined && root !== requiredRoot) malformed();
  // SheetJS selects binary parsers by content type and by a part's .bin suffix.
  // Inert VBA attachments remain allowed, but no binary financial part is admitted.
  if (name === "Override") assertContentType(tag);
  if (name === "Relationship") assertRelationship(tag);
};

type XmlMember = Readonly<{ root: string; text: string }>;
const xmlMembers = (entries: Map<string, Uint8Array>): ReadonlyArray<XmlMember> => {
  const members: Array<XmlMember> = [];
  for (const [name, bytes] of entries) {
    if (
      ["xl/workbook.bin", "META-INF/manifest.xml", "objectdata.xml", "Index/Document.iwa"].includes(
        name
      )
    ) {
      limit();
    }
    // OOXML parts can have nonstandard names. Inspect all XML-looking members too.
    if (
      !name.endsWith(".xml") &&
      !/^\s*</u.test(new TextDecoder().decode(bytes.subarray(0, xmlChunkCharacters)))
    ) {
      continue;
    }
    const text = decoder.decode(bytes);
    let root = "";
    scan(text, (parser) => {
      parser.on("cdata", malformed);
      parser.on("comment", malformed);
      parser.on("processinginstruction", malformed);
      parser.on("opentag", (tag) => {
        assertAttributes(tag);
        if (root === "") root = localName(tag.name);
        assertXmlRepresentation(tag, root);
      });
    });
    members.push({ root, text });
  }
  if (members.some((member) => member.root === "document-content")) return malformed();
  return members;
};

const assertStringItem = (tag: SaxesTagPlain, alreadyOpen: boolean): void => {
  if (alreadyOpen || tag.isSelfClosing || Object.keys(tag.attributes).length !== 0) malformed();
};
const sharedStringSizes = (members: ReadonlyArray<XmlMember>): ReadonlyArray<number> => {
  const tables = members.filter((member) => member.root === "sst");
  if (tables.length > 1) return malformed();
  const sizes: Array<number> = [];
  for (const table of tables) {
    let item = false;
    let bytes = 0;
    let hasText = false;
    let text = "";
    let depth = 0;
    scan(table.text, (parser) => {
      parser.on("opentag", (tag) => {
        const name = localName(tag.name);
        depth += 1;
        if (depth === 2 && !["si", "sstItem"].includes(name)) malformed();
        if (name === "si" || name === "sstItem") {
          assertStringItem(tag, item);
          item = true;
          bytes = 0;
          text = "";
          hasText = false;
        }
        if (item && name === "t") hasText = true;
      });
      parser.on("text", (chunk) => {
        if (item) {
          bytes += size(chunk);
          text += chunk;
        } else if (chunk.trim() !== "") malformed();
      });
      parser.on("cdata", malformed);
      parser.on("closetag", (tag) => {
        depth -= 1;
        if (!["si", "sstItem"].includes(localName(tag.name))) return;
        if (!hasText) return malformed();
        assertNumericText(text);
        sizes.push(bytes);
        item = false;
      });
    });
  }
  return sizes;
};

const retainFormat = (tag: SaxesTagPlain, formats: Map<number, number>): void => {
  const bytes = size(tag.attributes.formatCode ?? "");
  if (bytes > maximumFormatBytes) limit();
  const id = indexFor(tag.attributes.numFmtId ?? "");
  if (formats.has(id)) malformed();
  formats.set(id, bytes);
};
const assertFormula = (tag: SaxesTagPlain): void => {
  if (localName(tag.name) === "f" && ["shared", "array"].includes(tag.attributes.t ?? "")) limit();
};

const formatSizes = (members: ReadonlyArray<XmlMember>): ReadonlyArray<number> => {
  const styles = members.filter((member) => member.root === "styleSheet");
  if (styles.length > 1) return malformed();
  const formats = new Map<number, number>();
  const cells: Array<number> = [];
  for (const style of styles) {
    let inCellFormats = false;
    const sections = new Set<string>();
    scan(style.text, (parser) => {
      parser.on("opentag", (tag) => {
        const name = localName(tag.name);
        if (["numFmts", "cellXfs"].includes(name)) {
          if (sections.has(name)) malformed();
          sections.add(name);
        }
        if (name === "cellXfs") inCellFormats = true;
        if (name === "numFmt") retainFormat(tag, formats);
        if (inCellFormats && name === "xf") cells.push(indexFor(tag.attributes.numFmtId ?? "0"));
      });
      parser.on("closetag", (tag) => {
        if (localName(tag.name) === "cellXfs") inCellFormats = false;
      });
    });
  }
  return cells.map((id) => formats.get(id) ?? 0);
};

type CellCost = {
  value: string;
  text: string;
  textBytes: number;
  shared: boolean;
  formatBytes: number;
  inValue: boolean;
};

type WorksheetInput = Readonly<{
  xml: string;
  strings: ReadonlyArray<number>;
  formats: ReadonlyArray<number>;
  charge: (cost: number) => void;
}>;
const admitWorksheet = ({ xml, strings, formats, charge }: WorksheetInput): void => {
  let cell = Option.none<CellCost>();
  const open = (tag: SaxesTagPlain): void => {
    const name = localName(tag.name);
    if (name === "c") {
      if (Option.isSome(cell)) return malformed();
      const style = indexFor(tag.attributes.s ?? "0");
      const formatBytes = formats[style] ?? 0;
      cell = Option.some({
        value: "",
        text: "",
        textBytes: 0,
        shared: tag.attributes.t === "s",
        formatBytes,
        inValue: false,
      });
    }
    if (Option.isSome(cell) && name === "v") cell.value.inValue = true;
    // Shared formulas can amplify before the cell callback. Their translation is excluded
    // from this admitted envelope; ordinary inert formula evidence remains supported.
    assertFormula(tag);
  };
  scan(xml, (parser) => {
    parser.on("opentag", open);
    parser.on("text", (text) => {
      if (Option.isNone(cell)) return;
      cell.value.textBytes += size(text);
      cell.value.text += text;
      if (cell.value.inValue) cell.value.value += text;
    });
    parser.on("cdata", malformed);
    parser.on("closetag", (tag) => {
      const name = localName(tag.name);
      if (Option.isNone(cell)) return;
      if (name === "v") cell.value.inValue = false;
      if (name !== "c") return;
      const referenced = cell.value.shared ? strings[indexFor(cell.value.value)] : 0;
      if (referenced === undefined) return malformed();
      const valueBytes = cell.value.textBytes + referenced;
      // Custom formats can repeat a value for each format token, or emit long literals.
      // Charge an upper bound before the foreign formatter sees any cell.
      charge(valueBytes + (valueBytes + numericFormattingAllowance) * cell.value.formatBytes);
      assertNumericText(cell.value.text);
      cell = Option.none();
    });
  });
};

/** Admit repeated text and formatting work before workbook construction; never truncates evidence. */
export const admitXlsxArchive = (bytes: Uint8Array): Uint8Array => {
  const entries = decodeXlsxArchive(bytes);
  const members = xmlMembers(entries);
  const worksheets = members.filter((member) => member.root === "worksheet");
  if (worksheets.length === 0) return malformed();
  if (worksheets.length > maximumSheets) limit();
  const strings = sharedStringSizes(members);
  const formats = formatSizes(members);
  let referencedBytes = 0;
  let cells = 0;
  const charge = (cost: number): void => {
    cells += 1;
    referencedBytes += cost;
    if (
      cells > maximumCells ||
      referencedBytes > statementParserLimits.maximumReferencedTextBytes
    ) {
      limit();
    }
  };
  for (const worksheet of worksheets) {
    admitWorksheet({ xml: worksheet.text, strings, formats, charge });
  }
  return encodeXlsxArchive(entries);
};
