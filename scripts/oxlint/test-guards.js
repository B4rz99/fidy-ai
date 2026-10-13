/** @typedef {import("./ast-types.js").Rule} OxlintRule */
/** @typedef {import("./ast-types.js").Node} Node */
/** @typedef {import("./ast-types.js").ImportDeclaration} ImportDeclaration */
/** @typedef {import("./ast-types.js").RuleContext} RuleContext */

/** @param {Node} node - Statically named property or imported export. */
const staticName = (node) => {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
};

/** @param {Node} node - Member access whose property is inspected. */
const memberName = (node) => {
  if (node.type !== "MemberExpression") return undefined;
  if (node.computed && node.property.type !== "Literal") return undefined;
  return staticName(node.property);
};

/**
 * @param {RuleContext} context - File's scope authority.
 * @param {import("./ast-types.js").MemberExpression} node - Access through a module or alias.
 * @param {Set<Node>} visited - Cycle guard for local aliases.
 * @returns {ReadonlyArray<string>}
 */
const memberPath = (context, node, visited) => {
  const name = memberName(node);
  const parent = modulePath(context, node.object, visited);
  return name === undefined || parent.length === 0 ? [] : [...parent, name];
};

/**
 * @param {Node} node - Module-loading expression.
 * @returns {string | undefined}
 */
const loadedModule = (node) => {
  if (node.type === "ImportExpression") return staticName(node.source);
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return undefined;
  if (node.callee.name !== "require" || node.arguments.length !== 1) return undefined;
  const argument = node.arguments[0];
  return argument === undefined ? undefined : staticName(argument);
};

/**
 * @param {RuleContext} context - File's scope authority.
 * @param {Node & { type: "Identifier" }} node - Identifier whose binding is resolved.
 */
const bindingOf = (context, node) => {
  /** @type {ReturnType<RuleContext["sourceCode"]["getScope"]> | null} */
  let scope = context.sourceCode.getScope(node);
  while (scope !== null) {
    const binding = scope.set.get(node.name);
    if (binding !== undefined) return binding;
    scope = scope.upper;
  }
  return undefined;
};

/**
 * @param {Node} node - Import binding.
 * @returns {ReadonlyArray<string>}
 */
const importPath = (node) => {
  const declaration = node.parent;
  if (declaration?.type !== "ImportDeclaration") return [];
  const source = declaration.source.value;
  if (typeof source !== "string") return [];
  if (node.type === "ImportSpecifier") return [source, staticName(node.imported) ?? ""];
  return [source];
};

const globalPaths = new Map([
  ["vi", ["vitest", "vi"]],
  ["jest", ["@jest/globals", "jest"]],
]);

/**
 * @param {import("./ast-types.js").VariableDeclarator} declaration - Local alias declaration.
 * @param {string} name - Bound identifier.
 * @returns {ReadonlyArray<string>}
 */
const destructuredPath = (declaration, name) => {
  if (declaration.id.type !== "ObjectPattern") return [];
  for (const property of declaration.id.properties) {
    if (property.type !== "Property" || property.value.type !== "Identifier") continue;
    if (property.value.name !== name) continue;
    const key = staticName(property.key);
    if (key !== undefined) return [key];
  }
  return [];
};

/**
 * Resolve imports and local aliases through lexical bindings so a shadowed `vi` stays ordinary data.
 * @param {RuleContext} context - File's scope authority.
 * @param {Node} node - Expression whose module origin is followed.
 * @param {Set<Node>} visited - Cycle guard for local aliases.
 * @returns {ReadonlyArray<string>}
 */
const modulePath = (context, node, visited = new Set()) => {
  if (visited.has(node)) return [];
  visited.add(node);
  const source = loadedModule(node);
  if (source !== undefined) return [source];
  if (node.type === "AwaitExpression") return modulePath(context, node.argument, visited);
  if (node.type === "ChainExpression") return modulePath(context, node.expression, visited);
  if (node.type === "MemberExpression") return memberPath(context, node, visited);
  if (node.type === "Identifier") return identifierPath(context, node, visited);
  return [];
};

/**
 * @param {RuleContext} context - File's scope authority.
 * @param {Node & { type: "Identifier" }} node - Imported or aliased identifier.
 * @param {Set<Node>} visited - Cycle guard for local aliases.
 * @returns {ReadonlyArray<string>}
 */
const identifierPath = (context, node, visited) => {
  const binding = bindingOf(context, node);
  const definition = binding === undefined ? undefined : binding.defs[0];
  if (definition === undefined) return globalPaths.get(node.name) ?? [];
  if (definition.type === "ImportBinding") return importPath(definition.node);
  const declaration = definition.node;
  if (definition.type !== "Variable") return [];
  if (declaration.type !== "VariableDeclarator") return [];
  return aliasPath(context, { declaration, name: node.name }, visited);
};

/**
 * @param {RuleContext} context - File's scope authority.
 * @param {{ declaration: import("./ast-types.js").VariableDeclarator, name: string }} input - Local alias binding.
 * @param {Set<Node>} visited - Cycle guard for local aliases.
 * @returns {ReadonlyArray<string>}
 */
const aliasPath = (context, { declaration, name }, visited) => {
  if (declaration.init === null) return [];
  const parent = modulePath(context, declaration.init, visited);
  if (parent.length === 0) return [];
  return [...parent, ...destructuredPath(declaration, name)];
};

const moduleMockPaths = new Set([
  "vitest.vi.mock",
  "vitest.vi.doMock",
  "vitest.vitest.mock",
  "vitest.vitest.doMock",
  "@jest/globals.jest.mock",
  "@jest/globals.jest.doMock",
  "@jest/globals.jest.setMock",
  "@jest/globals.jest.unstable_mockModule",
  "bun:test.mock.module",
  "node:test.mock.module",
]);

/** @satisfies {OxlintRule} */
const noModuleMocks = {
  meta: {
    type: "problem",
    docs: { description: "Supply test dependencies through Effect Layers instead of module mocks" },
    messages: {
      moduleMock:
        "Module mocking is banned. Supply boundary dependencies through Effect dependency injection and test Layers at existing service seams; call pure functions directly and use real platform bindings for integration tests.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (moduleMockPaths.has(modulePath(context, node.callee).join("."))) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
};

/** @satisfies {OxlintRule} */
const noTsxTests = {
  meta: {
    type: "problem",
    docs: { description: "Cover UI workflows in browser acceptance tests" },
    messages: {
      tsxTest:
        ".test.tsx files are banned. Cover UI workflows in Playwright browser acceptance tests; test independently meaningful pure logic and Effect programs in .test.ts files.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program(node) {
        if (context.filename.endsWith(".test.tsx")) {
          context.report({ node, messageId: "tsxTest" });
        }
      },
    };
  },
};

/** @param {string} source - Static module specifier. */
const isReactTestTool = (source) =>
  source.startsWith("@testing-library/") ||
  ["react-test-renderer", "react-dom/test-utils", "enzyme", "@vitest/browser-react"].some(
    (name) => source === name || source.startsWith(`${name}/`)
  );

/** @satisfies {OxlintRule} */
const noReactTestTools = {
  meta: {
    type: "problem",
    docs: { description: "Use Playwright for UI workflows instead of component unit-test tooling" },
    messages: {
      reactTestTool:
        "React unit-test tooling is banned. Exercise meaningful UI workflows through Playwright browser acceptance; keep pure logic and Effect tests independent of rendering.",
    },
    schema: [],
  },
  create(context) {
    /** @param {Node} node - Static module reference. */
    const checkSource = (node) => {
      const source = staticName(node);
      if (source !== undefined && isReactTestTool(source)) {
        context.report({ node, messageId: "reactTestTool" });
      }
    };
    return {
      ImportDeclaration: (node) => checkSource(node.source),
      ExportNamedDeclaration(node) {
        if (node.source !== null) checkSource(node.source);
      },
      ExportAllDeclaration: (node) => checkSource(node.source),
      ImportExpression: (node) => checkSource(node.source),
      CallExpression(node) {
        const source = loadedModule(node);
        if (source !== undefined && isReactTestTool(source)) {
          context.report({ node, messageId: "reactTestTool" });
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "test-guards" },
  rules: {
    "no-module-mocks": noModuleMocks,
    "no-tsx-tests": noTsxTests,
    "no-react-test-tools": noReactTestTools,
  },
};

export default plugin;
