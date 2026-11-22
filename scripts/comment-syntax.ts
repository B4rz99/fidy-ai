import { parse as parseAstro } from "@astrojs/compiler-rs";
import { tokenTypes, tokenize } from "css-tree";
import { Predicate, Schema } from "effect";
import { visit } from "jsonc-parser";
import { parseSync } from "oxc-parser";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse as parseHtml } from "parse5";
import { createSourceIndex, parse as parseShell, walk } from "sh-syntax/sync";
import { parseTOML } from "toml-eslint-parser";
import { CST, Lexer } from "yaml";

const Range = Schema.Struct({ start: Schema.Int, end: Schema.Int });

type Range = typeof Range.Type;

export const SourceComment = Schema.Struct({
  ...Range.fields,
  file: Schema.String,
  line: Schema.Int,
  text: Schema.String,
});

export type SourceComment = typeof SourceComment.Type;

const javaScript = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

const json = /(?:\.jsonc?$|(?:^|\/)bun\.lock$)/u;

const yaml = /\.ya?ml$/u;

const html = /\.(?:html|svg)$/u;

const css = /\.css$/u;

const astro = /\.astro$/u;

const shell = /\.sh$/u;

const toml = /\.toml$/u;

const sql = /\.sql$/u;

const scriptRanges = (file: string, source: string): ReadonlyArray<Range> => {
  const result = parseSync(file, source);
  const error = result.errors[0];

  if (error !== undefined) throw new Error(error.message);

  return result.comments;
};

const cssRanges = (source: string): ReadonlyArray<Range> => {
  const ranges: Array<Range> = [];
  tokenize(source, (type, start, end) => {
    if (type === tokenTypes.Comment) ranges.push({ start, end });
  });

  return ranges;
};

const jsonRanges = (source: string): ReadonlyArray<Range> => {
  const ranges: Array<Range> = [];
  visit(source, {
    onComment: (start, length) => {
      ranges.push({ start, end: start + length });
    },
  });

  return ranges;
};

const yamlRanges = (source: string): ReadonlyArray<Range> => {
  const ranges: Array<Range> = [];
  let offset = 0;
  let scalar = false;

  for (const lexeme of new Lexer().lex(source)) {
    const type = CST.tokenType(lexeme);

    if (!scalar && [CST.DOCUMENT, CST.FLOW_END, CST.SCALAR].includes(lexeme)) {
      scalar = lexeme === CST.SCALAR;
      continue;
    }

    const end = offset + lexeme.length;

    if (!scalar && type === "comment") ranges.push({ start: offset, end });
    scalar = false;
    offset = end;
  }

  return ranges;
};

const offsetRanges = (ranges: ReadonlyArray<Range>, offset: number): ReadonlyArray<Range> =>
  ranges.map(({ start, end }) => ({ start: start + offset, end: end + offset }));

const embeddedHtml = (
  node: DefaultTreeAdapterTypes.Element,
  source: string
): ReadonlyArray<Range> => {
  const location = node.sourceCodeLocation;

  if (location?.startTag === undefined || location.endTag === undefined) return [];
  const start = location.startTag.endOffset;
  const body = source.slice(start, location.endTag.startOffset);

  if (node.tagName === "style") return offsetRanges(cssRanges(body), start);
  const type = node.attrs.find((attribute) => attribute.name === "type")?.value ?? "";

  if (/^(?:|module|(?:text|application)\/(?:java|ecma)script)$/iu.test(type.trim())) {
    return offsetRanges(scriptRanges("inline.js", body), start);
  }

  return [];
};

const htmlNodeRanges = (
  node: DefaultTreeAdapterTypes.Node,
  source: string
): ReadonlyArray<Range> => {
  if (defaultTreeAdapter.isCommentNode(node) && node.sourceCodeLocation != null) {
    const { startOffset, endOffset } = node.sourceCodeLocation;

    return [{ start: startOffset, end: endOffset }];
  }

  if (
    defaultTreeAdapter.isElementNode(node) &&
    (node.tagName === "script" || node.tagName === "style")
  ) {
    return embeddedHtml(node, source);
  }

  if ("content" in node) return htmlNodeRanges(node.content, source);
  const children = "childNodes" in node ? node.childNodes : [];

  return children.flatMap((child) => htmlNodeRanges(child, source));
};

const isAstroComment = Schema.is(
  Schema.Struct({ ...Range.fields, type: Schema.Literal("AstroComment") })
);

const isAstroStyle = Schema.is(
  Schema.Struct({
    type: Schema.Literal("JSXElement"),
    openingElement: Schema.Struct({
      end: Schema.Int,
      name: Schema.Struct({ name: Schema.Literal("style") }),
    }),
    closingElement: Schema.Struct({ start: Schema.Int }),
  })
);

const decodeAstro = Schema.decodeUnknownSync(
  Schema.Struct({ comments: Schema.Array(Range), body: Schema.Array(Schema.Unknown) })
);

const astroNodeRanges = (node: unknown, source: string): ReadonlyArray<Range> => {
  if (isAstroComment(node)) return [{ start: node.start, end: node.end }];

  if (isAstroStyle(node)) {
    const start = node.openingElement.end;

    return offsetRanges(cssRanges(source.slice(start, node.closingElement.start)), start);
  }

  if (Array.isArray(node)) return node.flatMap((child: unknown) => astroNodeRanges(child, source));

  if (!Predicate.isObject(node)) return [];
  const children: ReadonlyArray<unknown> = Object.values(node);

  return children.flatMap((child) => astroNodeRanges(child, source));
};

const astroRanges = (source: string): ReadonlyArray<Range> => {
  const { ast, diagnostics } = parseAstro(source);
  const diagnostic = diagnostics[0];

  if (diagnostic !== undefined) throw new Error(diagnostic.text);
  const { comments, body } = decodeAstro(ast);

  return [...comments, ...body.flatMap((node) => astroNodeRanges(node, source))];
};

const shellRanges = (source: string, file: string): ReadonlyArray<Range> => {
  const index = createSourceIndex(source);
  const parsed = parseShell(source, { filepath: file, keepComments: true });
  const ranges: Array<Range> = [];
  walk(parsed, (node) => {
    if (node.type === "Comment" && (node.start !== 0 || !source.startsWith("#!"))) {
      ranges.push({ start: index(node.start), end: index(node.end) });
    }
  });

  return ranges;
};

const tomlRanges = (source: string): ReadonlyArray<Range> =>
  parseTOML(source).comments.map(({ range: [start, end] }) => ({ start, end }));

const sqlRanges = (source: string): ReadonlyArray<Range> =>
  source
    .matchAll(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|(?<comment>--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$))/gu
    )
    .filter(({ groups }) => groups?.["comment"] !== undefined)
    .map(({ 0: text, index }) => ({ start: index, end: index + text.length }))
    .toArray();

type CommentParser = (source: string, file: string) => ReadonlyArray<Range>;

const parsers: ReadonlyArray<readonly [RegExp, CommentParser]> = [
  [javaScript, (source, file) => scriptRanges(file, source)],
  [json, jsonRanges],
  [yaml, yamlRanges],
  [html, (source) => htmlNodeRanges(parseHtml(source, { sourceCodeLocationInfo: true }), source)],
  [css, cssRanges],
  [astro, astroRanges],
  [shell, shellRanges],
  [toml, tomlRanges],
  [sql, sqlRanges],
];

export const supportsComments = (file: string): boolean =>
  parsers.some(([extension]) => extension.test(file));

const rangesIn = (file: string, source: string): ReadonlyArray<Range> =>
  parsers.find(([extension]) => extension.test(file))?.[1](source, file) ?? [];

export const commentsIn = ({
  file,
  source,
}: Readonly<{ file: string; source: string }>): ReadonlyArray<SourceComment> => {
  const ranges = rangesIn(file, source).toSorted((left, right) => left.start - right.start);
  let line = 1;
  let offset = 0;

  return ranges.map(({ start, end }) => {
    for (let newline = source.indexOf("\n", offset); newline !== -1 && newline < start;) {
      line += 1;
      newline = source.indexOf("\n", newline + 1);
    }

    offset = start;

    return { file, line, start, end, text: source.slice(start, end) };
  });
};
