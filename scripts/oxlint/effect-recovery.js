/** @typedef {import("./ast-types.js").Rule} Rule */
/** @typedef {import("./ast-types.js").RuleContext} RuleContext */
/** @typedef {import("./ast-types.js").Node} Node */

/** @param {Node} node - Static member or imported name. */
const staticName = (node) => {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
};

/**
 * @param {import("./ast-types.js").ImportSpecifier} specifier - Named import binding.
 * @param {string} source - Imported module.
 * @returns {ReadonlyArray<string>}
 */
const namedImportPath = (specifier, source) => {
  if (specifier.importKind === "type") return [];
  const name = staticName(specifier.imported);
  if (source === "effect" && name === "Effect") return ["Effect"];
  if (source === "effect/Effect" && name !== undefined) return ["Effect", name];
  return [];
};

/**
 * @param {Node} specifier - Import binding.
 * @returns {ReadonlyArray<string>}
 */
const importPath = (specifier) => {
  const declaration = specifier.parent;
  if (declaration?.type !== "ImportDeclaration" || declaration.importKind === "type") return [];
  const source = declaration.source.value;
  if (specifier.type === "ImportSpecifier") return namedImportPath(specifier, source);
  return specifier.type === "ImportNamespaceSpecifier" && source === "effect/Effect"
    ? ["Effect"]
    : [];
};

/**
 * @param {RuleContext} context - Lexical scope authority.
 * @param {Node & { type: "Identifier" }} node - Imported identifier.
 * @returns {ReadonlyArray<string>}
 */
const importedPath = (context, node) => {
  /** @type {ReturnType<RuleContext["sourceCode"]["getScope"]> | null} */
  let scope = context.sourceCode.getScope(node);
  while (scope !== null) {
    const binding = scope.set.get(node.name);
    if (binding !== undefined) {
      const definition = binding.defs[0];
      return definition?.type === "ImportBinding" ? importPath(definition.node) : [];
    }
    scope = scope.upper;
  }
  return [];
};

/**
 * @param {RuleContext} context - Lexical scope authority.
 * @param {Node} node - Effect member expression.
 * @param {string} name - Expected Effect export.
 */
const isEffectExport = (context, node, name) => {
  if (node.type === "Identifier") return importedPath(context, node).join("/") === `Effect/${name}`;
  if (node.type !== "MemberExpression" || node.object.type !== "Identifier") return false;
  if (node.computed && node.property.type !== "Literal") return false;
  return (
    staticName(node.property) === name && importedPath(context, node.object).join("/") === "Effect"
  );
};

/**
 * @param {Node | undefined} node - Recovery callback.
 * @returns {node is import("./ast-types.js").ArrowFunctionExpression}
 */
const isEmptyFallback = (node) =>
  node?.type === "ArrowFunctionExpression" && !node.async && node.params.length === 0;

/** @satisfies {Rule} */
const noCatchSucceedNone = {
  meta: {
    type: "suggestion",
    docs: { description: "Use Effect's lazy value fallback for an empty Option recovery" },
    messages: {
      catchSucceedNone:
        "Use Effect.orElseSucceed(Option.none) for this typed-failure fallback. It preserves laziness, defects and interruption without a callback returning Effect.succeedNone; Effect.option would also wrap successful values.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.optional || ![1, 2].includes(node.arguments.length)) return;
        if (!isEffectExport(context, node.callee, "catch")) return;
        const callback = node.arguments.at(-1);
        if (!isEmptyFallback(callback)) return;
        if (!isEffectExport(context, callback.body, "succeedNone")) return;
        context.report({ node, messageId: "catchSucceedNone" });
      },
    };
  },
};

const plugin = {
  meta: { name: "effect-recovery" },
  rules: { "no-catch-succeed-none": noCatchSucceedNone },
};
export default plugin;
