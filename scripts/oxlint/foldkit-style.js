/** @typedef {import("./ast-types.js").Rule} OxlintRule */
/** @typedef {import("./ast-types.js").Node} Node */

const rawColor =
  /(?:bg|text|border|fill|stroke|ring|from|via|to)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d|(?:bg|text|border|fill|stroke|ring)-\[(?:#|rgb|hsl|oklch)/u;
/** @param {Node} node - Class expression to inspect. */
const hasRawColor = (node) => {
  if (node.type === "Literal") return typeof node.value === "string" && rawColor.test(node.value);
  if (node.type === "TemplateLiteral") {
    return node.quasis.some((part) => rawColor.test(part.value.raw));
  }
  return false;
};
/** @satisfies {OxlintRule} */
const semanticColors = {
  meta: {
    type: "problem",
    docs: { description: "Use semantic Fidy color tokens in native Foldkit views" },
    messages: {
      semantic:
        "Use Fidy semantic color tokens in Html.Class; approve new palette values in the UI owner and DESIGN.md.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "Class"
        ) {
          return;
        }
        for (const argument of node.arguments) {
          if (hasRawColor(argument)) context.report({ node: argument, messageId: "semantic" });
        }
      },
    };
  },
};
export default { meta: { name: "foldkit-style" }, rules: { "semantic-colors": semanticColors } };
