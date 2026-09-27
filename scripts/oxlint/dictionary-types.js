// Syntax-level resolution follows local aliases far enough to keep wrappers
// from laundering an open value contract. It deliberately does not pretend to
// be a TypeScript type checker.

/** @typedef {import("./ast-types.js").Node} Node */
/** @typedef {import("./ast-types.js").Program} Program */
/** @typedef {import("./ast-types.js").TSType} TSType */
/** @typedef {import("./ast-types.js").TSTypeReference} TSTypeReference */
/** @typedef {import("./ast-types.js").TypeEnvironment} TypeEnvironment */
/** @typedef {import("./ast-types.js").Resolution} Resolution */
/** @typedef {"unknown" | "any" | "object" | "empty-object" | "union" | null} UnsafeValue */
/** @typedef {{ type: TSType, substitutions: Map<string, TSType> }} DictionaryValue */

const BUILT_INS = new Set([
  "Record",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "PropertyKey",
  "NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);

/** @param {Node} statement - Top-level statement to unwrap. */
const declaredStatement = (statement) =>
  statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
    ? (statement.declaration ?? null)
    : statement;

/**
 * @param {string} name - Declared type name.
 * @param {import("./ast-types.js").TSTypeAliasDeclaration} declaration - Alias declaration.
 * @param {TypeEnvironment} environment - Local declaration index.
 */
const indexAlias = (name, declaration, environment) => {
  if (environment.aliases.has(name)) environment.shadowedBuiltIns.add(name);
  else environment.aliases.set(name, declaration);
};

/** @param {Node} declaration - Local declaration whose identifier may shadow a built-in. */
export const declarationName = (declaration) =>
  "id" in declaration && declaration.id?.type === "Identifier" ? declaration.id.name : undefined;

/**
 * @param {Node | null} declaration - Declaration, if present.
 * @param {TypeEnvironment} environment - Local declaration index.
 */
const indexNamedDeclaration = (declaration, environment) => {
  if (declaration === null) return;
  const name = declarationName(declaration);
  if (name === undefined) return;
  if (BUILT_INS.has(name)) environment.shadowedBuiltIns.add(name);
  if (declaration.type === "TSTypeAliasDeclaration") indexAlias(name, declaration, environment);
  if (declaration.type === "TSInterfaceDeclaration") {
    const declarations = environment.interfaces.get(name) ?? [];
    declarations.push(declaration);
    environment.interfaces.set(name, declarations);
  }
};

/**
 * @param {Node | null} declaration - Declaration, if present.
 * @param {TypeEnvironment} environment - Local declaration index.
 */
const indexDeclaration = (declaration, environment) => {
  if (declaration?.type !== "ImportDeclaration") {
    indexNamedDeclaration(declaration, environment);
    return;
  }
  for (const specifier of declaration.specifiers) {
    if (BUILT_INS.has(specifier.local.name)) environment.shadowedBuiltIns.add(specifier.local.name);
  }
};

/** Index local type declarations and names that shadow TypeScript utility types.
 * @param {Program} program - Parsed module whose local types are indexed.
 */
export const createTypeEnvironment = (program) => {
  /** @type {TypeEnvironment} */
  const environment = {
    aliases: new Map(),
    interfaces: new Map(),
    shadowedBuiltIns: new Set(),
  };
  for (const statement of program.body) indexDeclaration(declaredStatement(statement), environment);
  return environment;
};

/** @param {TSTypeReference} type - Reference to a named type. */
const referenceName = (type) => (type.typeName.type === "Identifier" ? type.typeName.name : null);

/**
 * @param {string} name - Candidate built-in name.
 * @param {TypeEnvironment} environment - Local shadowing declarations.
 */
const isBuiltIn = (name, environment) =>
  BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name);

/** @param {Node} type - Candidate type syntax to unwrap. */
const unwrap = (type) => {
  let current = type;
  while (
    current.type === "TSParenthesizedType" ||
    (current.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation;
  }
  return current;
};

/** @param {import("./ast-types.js").TSInterfaceBody["body"][number]} member - Member to inspect. */
const isEmptyMember = (member) =>
  member.type === "TSPropertySignature" &&
  member.optional === true &&
  member.typeAnnotation?.typeAnnotation.type === "TSNeverKeyword";

/** @param {import("./ast-types.js").TSTypeLiteral} type - Literal to inspect. */
const isEmptyLiteral = (type) => type.members.length === 0 || type.members.every(isEmptyMember);

/** @param {Array<import("./ast-types.js").TSInterfaceDeclaration>} declarations - Merged local declarations. */
const isEmptyInterface = (declarations) => {
  const declaration = declarations[0];
  if (declarations.length !== 1 || declaration === undefined) return false;
  return (
    declaration.extends.length === 0 &&
    (declaration.body.body.length === 0 || declaration.body.body.every(isEmptyMember))
  );
};

/**
 * @param {TSType} type - Type to inspect.
 * @param {string} name - Generic parameter name.
 */
const isUnappliedReferenceTo = (type, name) => {
  const unwrapped = unwrap(type);
  return (
    unwrapped.type === "TSTypeReference" &&
    referenceName(unwrapped) === name &&
    (unwrapped.typeArguments?.params.length ?? 0) === 0
  );
};

/**
 * @param {TSType} type - Type parameter or concrete type.
 * @param {Map<string, TSType>} substitutions - Generic bindings in scope.
 * @param {Set<string>} resolving - Parameters on this resolution path.
 * @returns {TSType}
 */
const resolveSubstitution = (type, substitutions, resolving = new Set()) => {
  const unwrapped = unwrap(type);
  if (unwrapped.type !== "TSTypeReference") return type;
  const name = referenceName(unwrapped);
  if (name === null || resolving.has(name)) return type;
  const substitution = substitutions.get(name);
  if (substitution === undefined) return type;
  return resolveSubstitution(substitution, substitutions, new Set([...resolving, name]));
};

/**
 * @param {import("./ast-types.js").TSTypeAliasDeclaration} alias - Local alias.
 * @param {TSTypeReference} type - Alias application.
 * @param {Map<string, TSType>} base - Existing generic bindings.
 */
const aliasSubstitutions = (alias, type, base) => {
  const next = new Map(base);
  const parameters = alias.typeParameters?.params ?? [];
  const arguments_ = type.typeArguments?.params ?? [];
  for (const [index, parameter] of parameters.entries()) {
    const argument = arguments_[index] ?? parameter.default;
    if (argument == null) return null;
    next.set(parameter.name.name, resolveSubstitution(argument, next));
  }
  return next;
};

// An alias visit carries the substitution scope and the names on this path;
// sibling visits must not share a cycle guard or a generic parameter binding.
/**
 * @param {TSTypeReference} type - Alias application.
 * @param {string} name - Resolved local alias name.
 * @param {Resolution} resolution - Current resolution path.
 */
const aliasVisit = (type, name, resolution) => {
  const alias = resolution.environment.aliases.get(name);
  if (alias === undefined || resolution.resolvingAliases.has(name)) return null;
  const substitutions = aliasSubstitutions(alias, type, resolution.substitutions);
  if (substitutions === null) return null;
  return {
    type: alias.typeAnnotation,
    resolution: {
      ...resolution,
      substitutions,
      resolvingAliases: new Set([...resolution.resolvingAliases, name]),
    },
  };
};

/**
 * @param {string} name - Parameter being substituted.
 * @param {TSType} substitution - Bound type.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {UnsafeValue}
 */
const unsafeSubstitution = (name, substitution, resolution) =>
  isUnappliedReferenceTo(substitution, name) ? null : unsafeDirectValue(substitution, resolution);

/**
 * @param {TSTypeReference} type - Local type application.
 * @param {string} name - Local declaration name.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {UnsafeValue}
 */
const unsafeDeclaredValue = (type, name, resolution) => {
  const declarations = resolution.environment.interfaces.get(name);
  if (declarations !== undefined) return isEmptyInterface(declarations) ? "empty-object" : null;
  const visit = aliasVisit(type, name, resolution);
  return visit === null ? null : unsafeDirectValue(visit.type, visit.resolution);
};

/**
 * @param {TSTypeReference} type - Named type reference.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {UnsafeValue}
 */
const unsafeReference = (type, resolution) => {
  const name = referenceName(type);
  if (name === null) return null;
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, resolution.environment)) {
    const wrapped = type.typeArguments?.params[0];
    return wrapped === undefined ? null : unsafeDirectValue(wrapped, resolution);
  }
  const substitution = resolution.substitutions.get(name);
  if (substitution !== undefined) return unsafeSubstitution(name, substitution, resolution);
  return unsafeDeclaredValue(type, name, resolution);
};

/**
 * @param {Node} type - Candidate composite type syntax.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {UnsafeValue}
 */
const unsafeCompositeValue = (type, resolution) => {
  if (type.type === "TSUnionType") {
    return type.types.some((member) => unsafeDirectValue(member, resolution) !== null)
      ? "union"
      : null;
  }
  if (type.type !== "TSIntersectionType") return null;
  const values = type.types.map((member) => unsafeDirectValue(member, resolution));
  if (values.includes("any")) return "any";
  return values.length > 0 && values.every((value) => value !== null) ? (values[0] ?? null) : null;
};

/**
 * @param {TSType} type - Direct dictionary value type.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {UnsafeValue}
 */
const unsafeDirectValue = (type, resolution) => {
  const unwrapped = unwrap(type);
  if (unwrapped.type === "TSUnknownKeyword") return "unknown";
  if (unwrapped.type === "TSAnyKeyword") return "any";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  if (unwrapped.type === "TSTypeLiteral" && isEmptyLiteral(unwrapped)) return "empty-object";
  if (unwrapped.type === "TSTypeReference") return unsafeReference(unwrapped, resolution);
  return unsafeCompositeValue(unwrapped, resolution);
};

/**
 * @param {TSTypeReference} type - Record application.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {Array<DictionaryValue>}
 */
const recordDictionaryValue = (type, resolution) => {
  const value = type.typeArguments?.params[1];
  return value === undefined ? [] : [{ type: value, substitutions: resolution.substitutions }];
};

/**
 * @param {TSTypeReference} type - Utility type application.
 * @param {string} name - Unshadowed built-in type name.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {Array<DictionaryValue>}
 */
const builtInDictionaryValues = (type, name, resolution) => {
  if (name === "Record") return recordDictionaryValue(type, resolution);
  if (TRANSPARENT_WRAPPERS.has(name) || name === "Pick" || name === "Omit") {
    const first = type.typeArguments?.params[0];
    return first === undefined ? [] : dictionaryValues(first, resolution);
  }
  return [];
};

/**
 * @param {TSTypeReference} type - Referenced dictionary type.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {Array<DictionaryValue>}
 */
const dictionaryReferenceValues = (type, resolution) => {
  const name = referenceName(type);
  if (name === null) return [];
  const substitution = resolution.substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? []
      : dictionaryValues(substitution, resolution);
  }
  if (isBuiltIn(name, resolution.environment)) {
    return builtInDictionaryValues(type, name, resolution);
  }
  const visit = aliasVisit(type, name, resolution);
  return visit === null ? [] : dictionaryValues(visit.type, visit.resolution);
};

/**
 * @param {Node} type - Syntax that may denote a dictionary.
 * @param {Resolution} resolution - Current resolution path.
 * @returns {Array<DictionaryValue>}
 */
const dictionaryValues = (type, resolution) => {
  const unwrapped = unwrap(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.flatMap((member) =>
      member.type === "TSIndexSignature"
        ? [{ type: member.typeAnnotation.typeAnnotation, substitutions: resolution.substitutions }]
        : []
    );
  }
  if (unwrapped.type === "TSMappedType") {
    return unwrapped.typeAnnotation === null
      ? []
      : [{ type: unwrapped.typeAnnotation, substitutions: resolution.substitutions }];
  }
  return unwrapped.type === "TSTypeReference"
    ? dictionaryReferenceValues(unwrapped, resolution)
    : [];
};

/** Classify an open object dictionary whose direct value contract is an escape hatch.
 * @param {Node} type - Type syntax to inspect.
 * @param {TypeEnvironment} environment - Local declaration index.
 */
export const classifyUnsafeDictionary = (type, environment) => {
  const resolution = { environment, substitutions: new Map(), resolvingAliases: new Set() };
  for (const value of dictionaryValues(type, resolution)) {
    const unsafeValue = unsafeDirectValue(value.type, {
      ...resolution,
      substitutions: value.substitutions,
    });
    if (unsafeValue !== null) return unsafeValue;
  }
  return null;
};

/** Classify the direct value annotation on a standalone index signature.
 * @param {TSType} type - Index signature value annotation.
 * @param {TypeEnvironment} environment - Local declaration index.
 */
export const classifyUnsafeDictionaryValue = (type, environment) =>
  unsafeDirectValue(type, { environment, substitutions: new Map(), resolvingAliases: new Set() });
