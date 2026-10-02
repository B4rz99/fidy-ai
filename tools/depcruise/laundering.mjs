// Bounded syntactic guard, not a proof of semantic encapsulation. Code review must also apply
// the public-surface rule in root ARCHITECTURE.md.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { ownership, serverPath } from "./publication.mjs";

/** @typedef {{source: string, dependencies: ReadonlyArray<{module: string, resolved: string}>}} GraphModule */
/** @typedef {{name: string, from: string, to: string, reason: string}} LaunderingViolation */
/** @typedef {Map<import("typescript").Symbol, Set<string>>} Bindings */
/** @typedef {string | undefined | typeof arrayIndex} MemberKey */
/** @typedef {{root: import("typescript").Node, path: ReadonlyArray<MemberKey>}} ContainerReference */
/** @typedef {{path: ReadonlyArray<MemberKey>, origins: Set<string>}} ContainerWrite */
/** @typedef {{checker: import("typescript").TypeChecker, intrinsics: import("typescript").SourceFile, bindings: Bindings, assignments: Map<import("typescript").Symbol, import("typescript").Expression[]>, writes: Map<import("typescript").Node, ContainerWrite[]>, privateTarget: (specifier: string) => string | undefined}} Provenance */
/** @typedef {import("typescript").VariableDeclaration | import("typescript").TypeAliasDeclaration | import("typescript").InterfaceDeclaration | import("typescript").FunctionDeclaration | import("typescript").ClassLikeDeclaration | import("typescript").BinaryExpression | import("typescript").CallExpression} AliasDeclaration */

const trio = /\/(contract|operations|runtime)\.ts$/u;
const sharedKernel = /^src\/core\/_shared\/(?:money|context|time)\.ts$/u;
const reason =
  "Published interfaces own their declarations and behavior; private values and types cannot be republished through exports or aliases.";
const arrayIndex = Symbol("array-index");

/** @param {import("typescript").ImportClause} clause - Local import declarations. */
const importNames = (clause) => {
  const names = clause.name === undefined ? [] : [clause.name];
  const named = clause.namedBindings;
  if (named === undefined) return names;
  if (ts.isNamespaceImport(named)) return [...names, named.name];
  return [...names, ...named.elements.map((element) => element.name)];
};

/** @param {Provenance} context - Module-local symbol provenance. @param {import("typescript").Statement} statement - Candidate import. */
const seedImport = (context, statement) => {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.importClause === undefined
  ) {
    return;
  }
  const target = context.privateTarget(statement.moduleSpecifier.text);
  if (target === undefined) return;
  for (const name of importNames(statement.importClause)) {
    const symbol = context.checker.getSymbolAtLocation(name);
    if (symbol !== undefined) context.bindings.set(symbol, new Set([target]));
  }
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Node} node - Binding use. */
const bindingOrigins = (context, node) => {
  const symbol = context.checker.getSymbolAtLocation(node);
  return symbol === undefined ? [] : [...(context.bindings.get(symbol) ?? [])];
};

/** @param {import("typescript").Expression} expression - Parentheses or assertions preserve binding identity. */
const wrappedValue = (expression) => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return expression.expression;
  }
  return undefined;
};

/** @param {import("typescript").Declaration} declaration - Compiler-resolved import binding. */
const importedName = (declaration) => {
  if (ts.isImportSpecifier(declaration)) {
    const statement = declaration.parent.parent.parent;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return [];
    return [
      {
        source: statement.moduleSpecifier.text,
        name: (declaration.propertyName ?? declaration.name).text,
      },
    ];
  }
  if (ts.isNamespaceImport(declaration)) {
    const statement = declaration.parent.parent;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return [];
    return [{ source: statement.moduleSpecifier.text, name: "*" }];
  }
  return [];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - An actual imported binding, not its spelling. */
const importedNames = (context, expression) =>
  context.checker
    .getSymbolAtLocation(expression)
    ?.declarations?.flatMap(importedName)
    .filter(({ source }) => context.privateTarget(source) === undefined) ?? [];

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Candidate Effect dual constructor. */
const isEffectDual = (context, expression) => {
  if (ts.isIdentifier(expression)) {
    return importedNames(context, expression).some(
      ({ source, name }) => source === "effect/Function" && name === "dual"
    );
  }
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "dual") return false;
  return importedNames(context, expression.expression).some(
    ({ source, name }) =>
      (source === "effect" && name === "Function") || (source === "effect/Function" && name === "*")
  );
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Effect dual keeps its second argument as the callable behavior. */
const dualBody = (context, expression) => {
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 2 ||
    !isEffectDual(context, expression.expression)
  ) {
    return undefined;
  }
  return expression.arguments[1];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Recognize the bound global Object, never a same-spelled parameter or import. */
const objectMethod = (context, expression) => {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return undefined;
  }
  const symbol = context.checker.getSymbolAtLocation(expression.expression.expression);
  return symbol?.declarations?.some(
    (declaration) => declaration.getSourceFile() === context.intrinsics
  ) === true
    ? expression.expression.name.text
    : undefined;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - These standard helpers return exactly their first argument. */
const objectTarget = (context, expression) => {
  if (!ts.isCallExpression(expression)) return undefined;
  const method = objectMethod(context, expression);
  return ["freeze", "seal", "assign", "defineProperty"].includes(method ?? "")
    ? expression.arguments[0]
    : undefined;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Narrow, source-backed identity wrappers. */
const transparentValue = (context, expression) =>
  wrappedValue(expression) ?? dualBody(context, expression) ?? objectTarget(context, expression);

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ShorthandPropertyAssignment} property - A shorthand resolves to its lexical value, not the property symbol. */
const shorthandOrigins = (context, property) => {
  const symbol = context.checker.getShorthandAssignmentValueSymbol(property);
  return symbol === undefined ? [] : [...(context.bindings.get(symbol) ?? [])];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ObjectLiteralElementLike} property - A value exposed by an object literal. @returns {ReadonlyArray<string>} */
const propertyOrigins = (context, property) => {
  if (ts.isPropertyAssignment(property)) return valueOrigins(context, property.initializer);
  if (ts.isSpreadAssignment(property)) return valueOrigins(context, property.expression);
  if (ts.isShorthandPropertyAssignment(property)) return shorthandOrigins(context, property);
  if (
    ts.isMethodDeclaration(property) ||
    ts.isGetAccessorDeclaration(property) ||
    ts.isSetAccessorDeclaration(property)
  ) {
    return callableOrigins(context, property);
  }
  return [];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - A static import exposes its resolved module namespace. @returns {ReadonlyArray<string>} */
const dynamicImportOrigins = (context, expression) => {
  if (
    !ts.isCallExpression(expression) ||
    expression.expression.kind !== ts.SyntaxKind.ImportKeyword
  ) {
    return [];
  }
  const specifier = expression.arguments[0];
  if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return [];
  const target = context.privateTarget(specifier.text);
  return target === undefined ? [] : [target];
};

/** @param {import("typescript").Expression} expression - Identity-selecting syntax has the same alternatives for values and mutable receivers. @returns {ReadonlyArray<import("typescript").Expression> | undefined} */
const identityAlternatives = (expression) => {
  if (ts.isConditionalExpression(expression)) {
    return [expression.whenTrue, expression.whenFalse];
  }
  if (!ts.isBinaryExpression(expression)) return undefined;
  if (
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken ||
    expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return [expression.right];
  }
  const selectors = [
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ];
  return selectors.includes(expression.operatorToken.kind)
    ? [expression.left, expression.right]
    : undefined;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Selection retains operand identity; predicates and transformations do not. @returns {ReadonlyArray<string>} */
const selectedOrigins = (context, expression) =>
  identityAlternatives(expression)?.flatMap((alternative) => valueOrigins(context, alternative)) ??
  dynamicImportOrigins(context, expression);

/** @param {import("typescript").ClassElement | import("typescript").ParameterDeclaration} member - Private storage is not part of the outward class surface. */
const isPrivateMember = (member) =>
  (member.name !== undefined && ts.isPrivateIdentifier(member.name)) ||
  (ts.canHaveModifiers(member) &&
    ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) ===
      true);

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").PropertyDeclaration} field - Published value and explicit field type. @returns {ReadonlyArray<string>} */
const fieldOrigins = (context, field) => [
  ...bindingOrigins(context, field.name),
  ...(field.initializer === undefined ? [] : valueOrigins(context, field.initializer)),
  ...(field.type === undefined
    ? []
    : typeOrigins(context, field.type, isCallable(context, field.initializer))),
];

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ConstructorDeclaration} constructor - Parameter properties are fields as well as constructor inputs. */
const constructorOrigins = (context, constructor) => [
  ...callableOrigins(context, constructor),
  ...constructor.parameters.flatMap((parameter) => {
    if (
      !ts.isParameterPropertyDeclaration(parameter, constructor) ||
      isPrivateMember(parameter) ||
      parameter.initializer === undefined
    ) {
      return [];
    }
    return valueOrigins(context, parameter.initializer);
  }),
];

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ClassElement} member - A class's outward declaration. @returns {ReadonlyArray<string>} */
const classMemberOrigins = (context, member) => {
  if (isPrivateMember(member)) return [];
  if (ts.isPropertyDeclaration(member)) return fieldOrigins(context, member);
  if (ts.isIndexSignatureDeclaration(member)) return typeOrigins(context, member);
  if (ts.isConstructorDeclaration(member)) return constructorOrigins(context, member);
  if (
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return callableOrigins(context, member);
  }
  return [];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ClassLikeDeclaration} declaration - A class publication includes its accessible members. @returns {ReadonlyArray<string>} */
const classOrigins = (context, declaration) => [
  ...declaration.members.flatMap((member) => classMemberOrigins(context, member)),
  ...(declaration.heritageClauses?.flatMap((heritage) => typeOrigins(context, heritage)) ?? []),
  ...(declaration.typeParameters?.flatMap((parameter) => typeOrigins(context, parameter)) ?? []),
];

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Outward container values. @returns {ReadonlyArray<string>} */
const compoundOrigins = (context, expression) => {
  if (ts.isClassExpression(expression)) return classOrigins(context, expression);
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap((property) => propertyOrigins(context, property));
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) =>
      valueOrigins(context, ts.isSpreadElement(element) ? element.expression : element)
    );
  }
  return selectedOrigins(context, expression);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Identifier} name - Direct local alias. @param {Set<import("typescript").Symbol>} seen - Cyclic aliases stop without resolving a container. */
const aliasInitializer = (context, name, seen) => {
  const symbol = context.checker.getSymbolAtLocation(name);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  return symbol.declarations?.find(ts.isVariableDeclaration)?.initializer;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Direct local aliases only; calls never acquire their inferred result provenance. @param {Set<import("typescript").Symbol>} [seen] - Cyclic aliases stop without resolving a container. @returns {import("typescript").ObjectLiteralExpression | import("typescript").ArrayLiteralExpression | undefined} */
const localContainer = (context, expression, seen = new Set()) => {
  if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
    return expression;
  }
  const wrapped = wrappedValue(expression);
  if (wrapped !== undefined) return localContainer(context, wrapped, seen);
  if (!ts.isIdentifier(expression)) return selectedContainer(context, expression, seen);
  const initializer = aliasInitializer(context, expression, seen);
  return initializer === undefined ? undefined : localContainer(context, initializer, seen);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Static nested literal access can retain the same allocation identity. @param {Set<import("typescript").Symbol>} seen - Alias cycle guard. @returns {import("typescript").ObjectLiteralExpression | import("typescript").ArrayLiteralExpression | undefined} */
const selectedContainer = (context, expression, seen) => {
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return undefined;
  }
  const container = localContainer(context, expression.expression, seen);
  const key = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : literalKey(expression.argumentExpression);
  if (container === undefined || key === undefined) return undefined;
  const value = literalMemberValue(context, container, key);
  return value === undefined ? undefined : localContainer(context, value, seen);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ObjectLiteralExpression | import("typescript").ArrayLiteralExpression} container - Original literal shape. @param {string} key - Statically selected property or index. @returns {import("typescript").Expression | undefined} */
const literalMemberValue = (context, container, key) => {
  if (ts.isArrayLiteralExpression(container)) return container.elements[Number(key)];
  const property = [...container.properties]
    .reverse()
    .find((candidate) => !ts.isSpreadAssignment(candidate) && propertyKey(candidate.name) === key);
  if (property === undefined) return undefined;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (!ts.isShorthandPropertyAssignment(property)) return undefined;
  const declaration = context.checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration;
  return declaration !== undefined && ts.isVariableDeclaration(declaration)
    ? declaration.initializer
    : undefined;
};

/** @param {import("typescript").Node} name - Computed or indexed access is precise only for a literal key. */
const literalKey = (name) =>
  ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;

/** @param {import("typescript").Node} name - Only statically known keys support precise selection. */
const propertyKey = (name) => {
  if (ts.isIdentifier(name)) return name.text;
  return literalKey(ts.isComputedPropertyName(name) ? name.expression : name);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Identifier} name - Lexical aliases share their declared allocation, including factory results. @param {Set<import("typescript").Symbol>} seen - Alias cycles terminate. @returns {ReadonlyArray<ContainerReference>} */
const identifierReferences = (context, name, seen) => {
  const symbol = context.checker.getSymbolAtLocation(name);
  if (symbol === undefined || seen.has(symbol)) return [];
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined) return [];
  const visited = new Set([...seen, symbol]);
  const values = [...declaredInitializers(declaration), ...(context.assignments.get(symbol) ?? [])];
  return [
    { root: declaration, path: [] },
    ...values.flatMap((value) => containerReferences(context, value, visited)),
  ];
};

/** @param {import("typescript").Node} declaration - Only syntax-established allocations are followed. */
const declaredInitializers = (declaration) =>
  ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
    ? [declaration.initializer]
    : [];

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Only lexical identities, never inferred call results. @param {Set<import("typescript").Symbol>} [seen] - Alias cycles terminate. @returns {ReadonlyArray<ContainerReference>} */
const containerReferences = (context, expression, seen = new Set()) => {
  if (ts.isIdentifier(expression)) return identifierReferences(context, expression, seen);
  const wrapped = wrappedValue(expression) ?? objectTarget(context, expression);
  if (wrapped !== undefined) return containerReferences(context, wrapped, seen);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const references = memberWriteReferences(context, expression, seen);
    const literal = localContainer(context, expression, seen);
    return [...references, ...(literal === undefined ? [] : [{ root: literal, path: [] }])];
  }
  return selectedContainerReferences(context, expression, seen);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Dynamic selection remains scoped to the possible receiver identities. @param {Set<import("typescript").Symbol>} seen - Alias cycle guard. @returns {ReadonlyArray<ContainerReference>} */
const selectedContainerReferences = (context, expression, seen) => {
  const alternatives = identityAlternatives(expression);
  if (alternatives !== undefined) {
    return alternatives.flatMap((alternative) => containerReferences(context, alternative, seen));
  }
  return expression.kind === ts.SyntaxKind.ThisKeyword ? [] : [{ root: expression, path: [] }];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").PropertyAccessExpression | import("typescript").ElementAccessExpression} member - A write changes the selected slot, not the previous value stored there. @param {Set<import("typescript").Symbol>} [seen] - Alias cycle guard. */
const memberWriteReferences = (context, member, seen = new Set()) => {
  const key = ts.isPropertyAccessExpression(member)
    ? member.name.text
    : literalKey(member.argumentExpression);
  return containerReferences(context, member.expression, seen).map((reference) => ({
    root: reference.root,
    path: [...reference.path, key],
  }));
};

/** @param {MemberKey} key - Array methods alter numeric entries, not metadata such as length. */
const isArrayIndex = (key) => typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key);

/** @param {MemberKey} first - Selected member. @param {MemberKey} second - Written member. */
const intersectingKeys = (first, second) => {
  if (first === undefined || second === undefined || first === second) return true;
  if (first === arrayIndex) return isArrayIndex(second);
  return second === arrayIndex && isArrayIndex(first);
};

/** @param {ReadonlyArray<MemberKey>} first - Selected path. @param {ReadonlyArray<MemberKey>} second - Written path; unknown keys intersect any sibling. */
const intersectingPaths = (first, second) =>
  first
    .slice(0, Math.min(first.length, second.length))
    .every((key, index) => intersectingKeys(key, second[index]));

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Whole values include descendant writes; selected members exclude unrelated siblings. */
const writtenOrigins = (context, expression) =>
  containerReferences(context, expression).flatMap((reference) =>
    (context.writes.get(reference.root) ?? []).flatMap((write) =>
      intersectingPaths(reference.path, write.path) ? [...write.origins] : []
    )
  );

/** @param {Provenance} context - Module-local provenance. @param {ContainerReference} reference - A precise or receiver-local wildcard member. @param {ReadonlyArray<string>} origins - Values stored into that member. */
const mergeWrite = (context, reference, origins) => {
  if (origins.length === 0) return false;
  const writes = context.writes.get(reference.root) ?? [];
  const existing = writes.find(
    (write) =>
      write.path.length === reference.path.length &&
      write.path.every((key, index) => key === reference.path[index])
  );
  const write = existing ?? { path: reference.path, origins: new Set() };
  const before = write.origins.size;
  for (const origin of origins) write.origins.add(origin);
  if (existing === undefined) writes.push(write);
  context.writes.set(reference.root, writes);
  return before !== write.origins.size;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ObjectLiteralExpression} object - A locally declared container. @param {string} key - Selected public property. @returns {ReadonlyArray<string> | undefined} */
const objectMemberOrigins = (context, object, key) => {
  for (const property of [...object.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) return undefined;
    const candidate = propertyKey(property.name);
    if (candidate === undefined) return undefined;
    if (candidate === key) return propertyOrigins(context, property);
  }
  return [];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").PropertyAccessExpression | import("typescript").ElementAccessExpression} expression - Select a known literal property without inheriting private siblings. */
const memberOrigins = (context, expression) => {
  const bound = bindingOrigins(
    context,
    ts.isPropertyAccessExpression(expression) ? expression.name : expression.argumentExpression
  );
  if (bound.length > 0) return bound;
  const container = localContainer(context, expression.expression);
  const key = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : literalKey(expression.argumentExpression);
  if (container !== undefined) return selectedLiteralOrigins(context, container, key);
  return containerReferences(context, expression.expression).flatMap((reference) =>
    importedContainerOrigins(context, reference.root)
  );
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Node} root - Direct private imports retain identity; ordinary allocations and call results do not acquire it. */
const importedContainerOrigins = (context, root) => {
  if (ts.isImportSpecifier(root) || ts.isNamespaceImport(root)) {
    return bindingOrigins(context, root.name);
  }
  if (ts.isImportClause(root) && root.name !== undefined) return bindingOrigins(context, root.name);
  if (ts.isCallExpression(root)) return dynamicImportOrigins(context, root);
  return [];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ObjectLiteralExpression | import("typescript").ArrayLiteralExpression} container - Original shape, separate from later keyed writes. @param {string | undefined} key - Unknown keys may select any member. @returns {ReadonlyArray<string>} */
const selectedLiteralOrigins = (context, container, key) => {
  if (key === undefined) return compoundOrigins(context, container);
  if (ts.isObjectLiteralExpression(container)) {
    return objectMemberOrigins(context, container, key) ?? compoundOrigins(context, container);
  }
  if (container.elements.some(ts.isSpreadElement)) return compoundOrigins(context, container);
  const element = literalMemberValue(context, container, key);
  return element === undefined ? [] : valueOrigins(context, element);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Direct binding expression. @returns {ReadonlyArray<string>} */
const declaredValueOrigins = (context, expression) => {
  if (ts.isIdentifier(expression)) return bindingOrigins(context, expression);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return callableOrigins(context, expression);
  }
  const wrapped = transparentValue(context, expression);
  if (wrapped !== undefined) return valueOrigins(context, wrapped);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return memberOrigins(context, expression);
  }
  return compoundOrigins(context, expression);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} expression - Declaration identity plus explicit mutations of that same value. @returns {ReadonlyArray<string>} */
const valueOrigins = (context, expression) => [
  ...declaredValueOrigins(context, expression),
  ...writtenOrigins(context, expression),
];

/** @param {import("typescript").BindingName} name - Identifier or destructuring pattern. @returns {ReadonlyArray<import("typescript").Identifier>} */
const bindingNames = (name) =>
  ts.isIdentifier(name)
    ? [name]
    : name.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
      );

/** @param {import("typescript").EntityName} name - A lexical type reference. @returns {import("typescript").Identifier} */
const typeRoot = (name) => (ts.isQualifiedName(name) ? typeRoot(name.left) : name);

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ImportTypeNode} node - Inline import type. */
const importTypeOrigins = (context, node) => {
  if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) return [];
  const target = context.privateTarget(node.argument.literal.text);
  return target === undefined ? [] : [target];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Node} node - Explicit type syntax. */
const typeReferenceOrigins = (context, node) => {
  if (ts.isTypeReferenceNode(node)) return bindingOrigins(context, typeRoot(node.typeName));
  if (ts.isTypeQueryNode(node)) return bindingOrigins(context, typeRoot(node.exprName));
  if (ts.isExpressionWithTypeArguments(node)) return valueOrigins(context, node.expression);
  if (ts.isImportTypeNode(node)) return importTypeOrigins(context, node);
  return [];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Node} node - Explicit type syntax. @param {boolean} [callable] - Callable wrappers may derive signatures from private implementation functions. @returns {ReadonlyArray<string>} */
const typeOrigins = (context, node, callable = false) => {
  if (callable && ts.isTypeQueryNode(node)) return [];
  const origins = [...typeReferenceOrigins(context, node)];
  ts.forEachChild(node, (child) => {
    origins.push(...typeOrigins(context, child, callable));
  });
  return origins;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").SignatureDeclaration} signature - Only explicit outward types, never implementation bodies. */
const signatureOrigins = (context, signature) => {
  const types = [
    signature.type,
    ...signature.parameters.map((parameter) => parameter.type),
    ...(signature.typeParameters?.flatMap((parameter) => [
      parameter.constraint,
      parameter.default,
    ]) ?? []),
  ];
  return types.flatMap((type) => (type === undefined ? [] : typeOrigins(context, type, true)));
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Node} node - Returns from one callable, excluding nested function bodies. @returns {ReadonlyArray<string>} */
const returnOrigins = (context, node) => {
  if (ts.isReturnStatement(node)) {
    return node.expression === undefined ? [] : valueOrigins(context, node.expression);
  }
  if (ts.isFunctionLike(node)) return [];
  /** @type {string[]} */
  const origins = [];
  ts.forEachChild(node, (child) => {
    origins.push(...returnOrigins(context, child));
  });
  return origins;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").FunctionLikeDeclaration} declaration - An outward callable's explicit types and returned bindings. @returns {ReadonlyArray<string>} */
const callableOrigins = (context, declaration) => {
  const origins = signatureOrigins(context, declaration);
  if (declaration.body === undefined) return origins;
  return [
    ...origins,
    ...(ts.isBlock(declaration.body)
      ? returnOrigins(context, declaration.body)
      : valueOrigins(context, declaration.body)),
  ];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression | undefined} expression - Candidate wrapper implementation. @returns {boolean} */
const isCallable = (context, expression) => {
  if (expression === undefined) return false;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return true;
  return isCallable(context, transparentValue(context, expression));
};

/**
 * @param {Provenance} context - Module-local provenance.
 * @param {import("typescript").Symbol} symbol - Declared lexical binding or parameter property.
 * @param {ReadonlyArray<string>} origins - Newly discovered private origins.
 */
const mergeSymbolOrigins = (context, symbol, origins) => {
  if (origins.length === 0) return false;
  const targets = context.bindings.get(symbol) ?? new Set();
  const before = targets.size;
  for (const origin of origins) targets.add(origin);
  context.bindings.set(symbol, targets);
  return targets.size !== before;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Node} name - Declared binding. @param {ReadonlyArray<string>} origins - Newly discovered private origins. */
const mergeOrigins = (context, name, origins) => {
  const symbol = context.checker.getSymbolAtLocation(name);
  return symbol === undefined ? false : mergeSymbolOrigins(context, symbol, origins);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").VariableDeclaration} declaration - Candidate local alias. */
const propagateVariable = (context, declaration) => {
  const origins =
    declaration.initializer === undefined
      ? []
      : [...valueOrigins(context, declaration.initializer)];
  if (ts.isIdentifier(declaration.name)) origins.push(...writtenOrigins(context, declaration.name));
  // Local annotations are implementation details; inferred call results do not inherit private
  // provenance. An outward variable's explicit annotation is part of its published signature.
  if (declaration.type !== undefined && ts.isSourceFile(declaration.parent.parent.parent)) {
    origins.push(
      ...typeOrigins(context, declaration.type, isCallable(context, declaration.initializer))
    );
  }
  return bindingNames(declaration.name)
    .map((name) => mergeOrigins(context, name, origins))
    .includes(true);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ClassElement} member - Private members retain provenance for explicit public release, without making private storage an export. @returns {ReadonlyArray<string>} */
const memberBindingOrigins = (context, member) => {
  if (ts.isPropertyDeclaration(member)) {
    return member.initializer === undefined ? [] : valueOrigins(context, member.initializer);
  }
  if (
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return callableOrigins(context, member);
  }
  return [];
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ConstructorDeclaration} constructor - Parameter properties have both input and field symbols. */
const propagateParameters = (context, constructor) =>
  constructor.parameters
    .flatMap((parameter) => {
      if (
        !ts.isParameterPropertyDeclaration(parameter, constructor) ||
        parameter.initializer === undefined
      ) {
        return [];
      }
      const origins = valueOrigins(context, parameter.initializer);
      return context.checker
        .getSymbolsOfParameterPropertyDeclaration(parameter, parameter.name.text)
        .map((symbol) => mergeSymbolOrigins(context, symbol, origins));
    })
    .includes(true);

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").ClassLikeDeclaration} declaration - Class aliases and member identities share the lexical symbol graph. */
const propagateClass = (context, declaration) => {
  const changes = declaration.members.map((member) => {
    if (ts.isConstructorDeclaration(member)) return propagateParameters(context, member);
    return (
      member.name !== undefined &&
      mergeOrigins(context, member.name, memberBindingOrigins(context, member))
    );
  });
  if (declaration.name !== undefined) {
    changes.push(mergeOrigins(context, declaration.name, classOrigins(context, declaration)));
  }
  return changes.includes(true);
};

/** @param {import("typescript").Node} node - Only direct and short-circuit assignments retain a selected value's identity. @returns {node is import("typescript").BinaryExpression} */
const isIdentityAssignment = (node) =>
  ts.isBinaryExpression(node) &&
  [
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ].includes(node.operatorToken.kind);

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").BinaryExpression} assignment - Record the assigned binding, never a callee's inferred return value. */
const propagateAssignment = (context, assignment) => {
  const left = assignment.left;
  if (ts.isIdentifier(left)) return mergeOrigins(context, left, valueOrigins(context, assignment));
  if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
    return propagateMemberWrite(context, left, valueOrigins(context, assignment));
  }
  return false;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").PropertyAccessExpression | import("typescript").ElementAccessExpression} target - Mutated member, with unknown keys scoped to its receiver. @param {ReadonlyArray<string>} origins - Selected assignment value. */
const propagateMemberWrite = (context, target, origins) => {
  const changes = memberWriteReferences(context, target).map((reference) =>
    mergeWrite(context, reference, origins)
  );
  const name = ts.isPropertyAccessExpression(target) ? target.name : target.argumentExpression;
  const symbol = context.checker.getSymbolAtLocation(name);
  if (symbol?.declarations?.some((declaration) => ts.isClassLike(declaration.parent)) === true) {
    changes.push(mergeSymbolOrigins(context, symbol, origins));
  }
  return changes.includes(true);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} receiver - Mutated allocation. @param {{key: MemberKey, origins: ReadonlyArray<string>}} write - Keyed or receiver-local wildcard write. */
const writeReceiver = (context, receiver, write) =>
  containerReferences(context, receiver)
    .map((reference) =>
      mergeWrite(
        context,
        { root: reference.root, path: [...reference.path, write.key] },
        write.origins
      )
    )
    .includes(true);

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} target - Object.assign's identity-preserved receiver. @param {import("typescript").Expression} source - Literal keys remain precise; opaque source writes stay receiver-local. */
const assignSource = (context, target, source) => {
  const literal = localContainer(context, source);
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
    return writeReceiver(context, target, {
      key: undefined,
      origins: valueOrigins(context, source),
    });
  }
  const changes = literal.properties.map((property) =>
    writeReceiver(context, target, {
      key: ts.isSpreadAssignment(property) ? undefined : propertyKey(property.name),
      origins: propertyOrigins(context, property),
    })
  );
  changes.push(
    writeReceiver(context, target, { key: undefined, origins: writtenOrigins(context, source) })
  );
  return changes.includes(true);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Expression} descriptor - Only stored values/accessors cross the object property boundary. */
const descriptorOrigins = (context, descriptor) => {
  const literal = localContainer(context, descriptor);
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
    return valueOrigins(context, descriptor);
  }
  return ["value", "get", "set"].flatMap(
    (key) => objectMemberOrigins(context, literal, key) ?? valueOrigins(context, descriptor)
  );
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").CallExpression} call - Bounded standard Object mutations, verified against their global binding. */
const propagateObjectCall = (context, call) => {
  const target = call.arguments[0];
  if (target === undefined) return false;
  const method = objectMethod(context, call);
  if (method === "assign") {
    return call.arguments
      .slice(1)
      .map((source) => assignSource(context, target, source))
      .includes(true);
  }
  const key = call.arguments[1];
  const descriptor = call.arguments[2];
  if (method !== "defineProperty" || key === undefined || descriptor === undefined) return false;
  return writeReceiver(context, target, {
    key: literalKey(key),
    origins: descriptorOrigins(context, descriptor),
  });
};

/** @param {import("typescript").Node} root - Literal or explicitly annotated array, never a method name alone. */
const isArrayAllocation = (root) => {
  if (ts.isArrayLiteralExpression(root)) return true;
  if (!ts.isVariableDeclaration(root) || root.type === undefined) return false;
  return ts.isArrayTypeNode(root.type) || ts.isTupleTypeNode(root.type);
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").CallExpression} call - Standard insertion methods transfer only inserted elements; their computed return values remain untainted. */
const propagateArrayCall = (context, call) => {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  if (!["push", "unshift", "splice"].includes(method)) return false;
  const receiver = call.expression.expression;
  if (
    !containerReferences(context, receiver).some((reference) => isArrayAllocation(reference.root))
  ) {
    return false;
  }
  const inserted = call.arguments.slice(method === "splice" ? 2 : 0);
  const origins = inserted.flatMap((value) =>
    valueOrigins(context, ts.isSpreadElement(value) ? value.expression : value)
  );
  return writeReceiver(context, receiver, { key: arrayIndex, origins });
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").CallExpression} call - Only the explicitly supported transparent mutation forms are followed. */
const propagateCall = (context, call) =>
  [propagateObjectCall(context, call), propagateArrayCall(context, call)].includes(true);

/** @param {Provenance} context - Module-local provenance. @param {AliasDeclaration} declaration - Runtime bindings and bounded writes are distinct from type/class declarations. */
const propagateRuntimeDeclaration = (context, declaration) => {
  if (ts.isVariableDeclaration(declaration)) return propagateVariable(context, declaration);
  if (ts.isBinaryExpression(declaration)) return propagateAssignment(context, declaration);
  if (ts.isCallExpression(declaration)) return propagateCall(context, declaration);
  return false;
};

/** @param {Provenance} context - Module-local provenance. @param {AliasDeclaration} statement - Candidate local declaration. */
const propagateDeclaration = (context, statement) => {
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
    return mergeOrigins(context, statement.name, typeOrigins(context, statement));
  }
  if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
    return mergeOrigins(context, statement.name, callableOrigins(context, statement));
  }
  if (ts.isClassLike(statement)) return propagateClass(context, statement);
  return propagateRuntimeDeclaration(context, statement);
};

/** @param {import("typescript").Node} node - Declarations retain their lexical compiler symbols at every nesting depth. @returns {ReadonlyArray<AliasDeclaration>} */
const aliasDeclarations = (node) => {
  /** @type {AliasDeclaration[]} */
  const declarations = [];
  if (
    ts.isVariableDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassLike(node) ||
    isIdentityAssignment(node) ||
    ts.isCallExpression(node)
  ) {
    declarations.push(node);
  }
  ts.forEachChild(node, (child) => {
    declarations.push(...aliasDeclarations(child));
  });
  return declarations;
};

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").SourceFile} source - Published file. */
const propagateAliases = (context, source) => {
  const declarations = aliasDeclarations(source);
  for (const declaration of declarations) rememberContainerAlias(context, declaration);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (propagateDeclaration(context, declaration)) changed = true;
    }
  }
};

/** @param {Provenance} context - Module-local provenance. @param {AliasDeclaration} declaration - Direct local assignments may establish another name for the same container. */
const rememberContainerAlias = (context, declaration) => {
  if (!ts.isBinaryExpression(declaration) || !ts.isIdentifier(declaration.left)) return;
  const symbol = context.checker.getSymbolAtLocation(declaration.left);
  if (symbol === undefined) return;
  const values = context.assignments.get(symbol) ?? [];
  values.push(declaration.right);
  context.assignments.set(symbol, values);
};

/** @param {Provenance} context - Module-local symbol provenance. @param {import("typescript").Statement} statement - Candidate export. */
const exportOrigins = (context, statement) => {
  if (!ts.isExportDeclaration(statement)) return [];
  if (statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
    const target = context.privateTarget(statement.moduleSpecifier.text);
    return target === undefined ? [] : [target];
  }
  if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) return [];
  return statement.exportClause.elements.flatMap((element) => {
    const symbol = context.checker.getExportSpecifierLocalTargetSymbol(element);
    return symbol === undefined ? [] : [...(context.bindings.get(symbol) ?? [])];
  });
};

/** @param {import("typescript").Statement} statement - Candidate published declaration. */
const isExported = (statement) =>
  ts.canHaveModifiers(statement) &&
  ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
    true;

/** @param {Provenance} context - Module-local provenance. @param {import("typescript").Statement} statement - Candidate outward binding. */
const outwardOrigins = (context, statement) => {
  if (ts.isExportAssignment(statement)) return valueOrigins(context, statement.expression);
  if (!isExported(statement)) return exportOrigins(context, statement);
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name).flatMap((name) => bindingOrigins(context, name))
    );
  }
  if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
    return bindingOrigins(context, statement.name);
  }
  if (ts.isFunctionDeclaration(statement)) return callableOrigins(context, statement);
  if (ts.isClassDeclaration(statement)) return classOrigins(context, statement);
  return [];
};

/**
 * @param {ReadonlyArray<GraphModule>} modules - Published files to bind, without loading dependencies.
 * @param {string} packageRoot - Graph cwd.
 * @param {(path: string) => string} readSource - Reads an absolute source path.
 */
const bindSources = (modules, packageRoot, readSource) => {
  const sources = new Map(
    modules.map(({ source }) => {
      const path = resolve(packageRoot, source);
      return [path, ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true)];
    })
  );
  const intrinsics = ts.createSourceFile(
    "/__depcruise_intrinsics__.d.ts",
    "declare const Object: unknown;",
    ts.ScriptTarget.Latest,
    true
  );
  sources.set(intrinsics.fileName, intrinsics);
  const options = { noResolve: true, noLib: true, types: [] };
  const host = ts.createCompilerHost(options);
  // The cruiser already resolved every edge. Bind lexical symbols without reading a second graph.
  host.getSourceFile = (path) => sources.get(path);
  const checker = ts.createProgram([...sources.keys()], options, host).getTypeChecker();
  return { sources, checker, intrinsics };
};

/** @param {import("typescript").SourceFile} source - Published declarations. @param {string} from - The direct interface must not contain a second namespace surface. @returns {ReadonlyArray<LaunderingViolation>} */
const namespaceViolations = (source, from) =>
  source.statements.some(ts.isModuleDeclaration)
    ? [
        {
          name: "published-interface-namespace",
          from,
          to: from,
          reason:
            "Published Trio files declare earned names directly; TypeScript namespace and module blocks cannot wrap or hide their public surface.",
        },
      ]
    : [];

/**
 * Reports private values or types exposed by a Published Trio file. Resolution and ownership come
 * from the complete graph, never the spelling of an import. Only outward bindings are inspected;
 * private implementation calls inside a newly declared operation are allowed.
 * @param {{modules: ReadonlyArray<GraphModule>}} report - Complete resolved dependency graph.
 * @param {string} packageRoot - Graph cwd.
 * @param {(path: string) => string} [readSource] - Reads absolute source paths; errors propagate.
 * @returns {ReadonlyArray<LaunderingViolation>} One diagnostic per published file and private target.
 */
export const launderingViolations = (
  report,
  packageRoot,
  readSource = (path) => readFileSync(path, "utf8")
) => {
  const owner = ownership(report.modules.map(({ source }) => serverPath(source, packageRoot)));
  /** @param {string} path - Normalized graph path. */
  const isPublished = (path) =>
    trio.test(path) && path.slice(0, path.lastIndexOf("/")) === owner(path);
  const published = report.modules.filter(({ source }) =>
    isPublished(serverPath(source, packageRoot))
  );
  const { sources, checker, intrinsics } = bindSources(published, packageRoot, readSource);
  return published.flatMap((module) => {
    const from = serverPath(module.source, packageRoot);
    const source = sources.get(resolve(packageRoot, module.source));
    if (source === undefined) return [];
    const namespaces = namespaceViolations(source, from);
    if (namespaces.length > 0) return namespaces;
    const targets = new Map(
      module.dependencies.map((dependency) => [
        dependency.module,
        serverPath(dependency.resolved, packageRoot),
      ])
    );
    /** @param {string} specifier - Source module spelling. */
    const privateTarget = (specifier) => {
      const target = targets.get(specifier);
      return target !== undefined &&
        owner(target) !== undefined &&
        !isPublished(target) &&
        !sharedKernel.test(target) &&
        target !== "src/shell/api.ts"
        ? target
        : undefined;
    };
    const context = {
      checker,
      intrinsics,
      bindings: new Map(),
      assignments: new Map(),
      writes: new Map(),
      privateTarget,
    };
    for (const statement of source.statements) seedImport(context, statement);
    propagateAliases(context, source);
    const exposed = new Set(
      source.statements.flatMap((statement) => outwardOrigins(context, statement))
    );
    return [...exposed].map((to) => ({
      name: "published-interface-reexports-internal",
      from,
      to,
      reason,
    }));
  });
};
