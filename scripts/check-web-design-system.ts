#!/usr/bin/env bun

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as Babel from "@babel/types";
import { Option } from "effect";

const paletteNames =
  "(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
const visualUtility =
  "(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|decoration|fill|stroke|from|via|to|shadow|accent|caret)";
const palettePattern = new RegExp(`^${visualUtility}-${paletteNames}(?:-|$)`, "u");
const arbitraryColorPattern = new RegExp(
  `^${visualUtility}-\\[(?:#|rgba?\\(|hsla?\\(|oklch\\(|oklab\\(|lch\\(|lab\\(|color\\(|var\\()`,
  "u"
);
const spacingPattern = /^space-[xy](?:-|$)/u;

type FindingReason = "arbitrary-color" | "dark-color" | "palette-color" | "space-layout";

type Finding = Readonly<{
  line: number;
  path: string;
  reason: FindingReason;
  token: string;
}>;

type ClassFragment = Readonly<{
  line: number;
  value: string;
}>;

const classFragments = (candidate: Option.Option<Babel.Node>): ReadonlyArray<ClassFragment> => {
  if (Option.isNone(candidate) || Babel.isJSXEmptyExpression(candidate.value)) return [];
  const node = candidate.value;
  if (Babel.isStringLiteral(node)) {
    return [{ line: node.loc?.start.line ?? 1, value: node.value }];
  }
  if (Babel.isJSXExpressionContainer(node)) return classFragments(Option.some(node.expression));
  if (Babel.isTemplateLiteral(node)) {
    return node.quasis.map((quasi) => ({
      line: quasi.loc?.start.line ?? 1,
      value: quasi.value.cooked ?? quasi.value.raw,
    }));
  }
  if (Babel.isConditionalExpression(node)) {
    return [
      ...classFragments(Option.some(node.consequent)),
      ...classFragments(Option.some(node.alternate)),
    ];
  }
  if (Babel.isLogicalExpression(node)) {
    return [...classFragments(Option.some(node.left)), ...classFragments(Option.some(node.right))];
  }
  if (Babel.isArrayExpression(node)) {
    return node.elements.flatMap((element) => classFragments(Option.fromNullOr(element)));
  }
  if (Babel.isCallExpression(node)) {
    return node.arguments.flatMap((argument) => classFragments(Option.some(argument)));
  }
  return [];
};

const baseUtility = (token: string): string => token.split(":").at(-1) ?? token;

const findingReason = (token: string): Option.Option<FindingReason> => {
  const utility = baseUtility(token);
  if (spacingPattern.test(utility)) return Option.some("space-layout");
  if (token.split(":").includes("dark") && visualUtilityPattern.test(utility)) {
    return Option.some("dark-color");
  }
  if (palettePattern.test(utility)) return Option.some("palette-color");
  if (arbitraryColorPattern.test(utility)) return Option.some("arbitrary-color");
  return Option.none();
};

const visualUtilityPattern = new RegExp(`^${visualUtility}-`, "u");

const inspectSource = (path: string, source: string): ReadonlyArray<Finding> => {
  const syntax = parse(source, {
    plugins: ["jsx", "typescript"],
    sourceType: "module",
  });
  const findings: Array<Finding> = [];
  traverse(syntax, {
    JSXAttribute(attributePath) {
      const attribute = attributePath.node;
      if (!Babel.isJSXIdentifier(attribute.name) || attribute.name.name !== "className") return;
      for (const fragment of classFragments(Option.fromNullishOr(attribute.value))) {
        for (const token of fragment.value.split(/\s+/u).filter(Boolean)) {
          const reason = findingReason(token);
          if (Option.isSome(reason)) {
            findings.push({ line: fragment.line, path, reason: reason.value, token });
          }
        }
      }
    },
  });
  return findings;
};

const reasonMessage: Record<FindingReason, string> = {
  "arbitrary-color": "use a semantic color token instead of an arbitrary color",
  "dark-color": "put light and dark values behind one semantic theme token",
  "palette-color": "use a semantic color such as card, muted, primary, or destructive",
  "space-layout": "use flex or grid with gap-* instead of space-x-* or space-y-*",
};

const probes: ReadonlyArray<Readonly<{ expected: FindingReason; source: string }>> = [
  { expected: "palette-color", source: `<div className="bg-blue-500" />` },
  { expected: "arbitrary-color", source: `<div className="text-[#123456]" />` },
  { expected: "dark-color", source: `<div className="dark:hover:bg-card" />` },
  { expected: "space-layout", source: `<div className="space-y-4" />` },
];
for (const probe of probes) {
  const findings = inspectSource("negative-probe.tsx", probe.source);
  if (!findings.some((finding) => finding.reason === probe.expected)) {
    throw new Error(`Design-system negative probe did not detect ${probe.expected}`);
  }
}

const workspaceRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const featureSources = new Bun.Glob("apps/web/src/features/**/*.tsx");
const findings: Array<Finding> = [];
for await (const path of featureSources.scan({ cwd: workspaceRoot })) {
  if (path.endsWith(".test.tsx")) continue;
  findings.push(...inspectSource(path, await Bun.file(`${workspaceRoot}${path}`).text()));
}

if (findings.length > 0) {
  const report = findings
    .map(
      (finding) =>
        `${finding.path}:${finding.line}: '${finding.token}' — ${reasonMessage[finding.reason]}`
    )
    .join("\n");
  throw new Error(`Web design-system policy failed:\n${report}`);
}

process.stdout.write("web design-system policy clean\n");
