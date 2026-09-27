// Syntax-level resolution follows local aliases far enough to keep wrappers
// from laundering an open value contract. It deliberately does not pretend to
// be a TypeScript type checker.

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

const declaredStatement = (statement) =>
  statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
    ? (statement.declaration ?? null)
    : statement;

const indexAlias = (name, declaration, environment) => {
  if (environment.aliases.has(name)) environment.shadowedBuiltIns.add(name);
  else environment.aliases.set(name, declaration);
};

const indexNamedDeclaration = (declaration, environment) => {
  const name = declaration?.id?.name;
  if (name === undefined) return;
  if (BUILT_INS.has(name)) environment.shadowedBuiltIns.add(name);
  if (declaration.type === "TSTypeAliasDeclaration") indexAlias(name, declaration, environment);
  if (declaration.type === "TSInterfaceDeclaration") {
    const declarations = environment.interfaces.get(name) ?? [];
    declarations.push(declaration);
    environment.interfaces.set(name, declarations);
  }
};

const indexDeclaration = (declaration, environment) => {
  if (declaration?.type !== "ImportDeclaration") {
    indexNamedDeclaration(declaration, environment);
    return;
  }
  for (const specifier of declaration.specifiers) {
    if (BUILT_INS.has(specifier.local.name)) environment.shadowedBuiltIns.add(specifier.local.name);
  }
};

/** Index local type declarations and names that shadow TypeScript utility types. */
export const createTypeEnvironment = (program) => {
  const environment = {
    aliases: new Map(),
    interfaces: new Map(),
    shadowedBuiltIns: new Set(),
  };
  for (const statement of program.body) indexDeclaration(declaredStatement(statement), environment);
  return environment;
};

const referenceName = (type) => (type.typeName.type === "Identifier" ? type.typeName.name : null);

const isBuiltIn = (name, environment) =>
  BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name);

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

const isEmptyMember = (member) =>
  member.type === "TSPropertySignature" &&
  member.optional === true &&
  member.typeAnnotation?.typeAnnotation.type === "TSNeverKeyword";

const isEmptyLiteral = (type) => type.members.length === 0 || type.members.every(isEmptyMember);

const isEmptyInterface = (declarations) => {
  if (declarations.length !== 1) return false;
  const declaration = declarations[0];
  return (
    declaration.extends.length === 0 &&
    (declaration.body.body.length === 0 || declaration.body.body.every(isEmptyMember))
  );
};

const isUnappliedReferenceTo = (type, name) => {
  const unwrapped = unwrap(type);
  return (
    unwrapped.type === "TSTypeReference" &&
    referenceName(unwrapped) === name &&
    (unwrapped.typeArguments?.params.length ?? 0) === 0
  );
};

const resolveSubstitution = (type, substitutions, resolving = new Set()) => {
  const unwrapped = unwrap(type);
  if (unwrapped.type !== "TSTypeReference") return type;
  const name = referenceName(unwrapped);
  if (name === null || resolving.has(name)) return type;
  const substitution = substitutions.get(name);
  if (substitution === undefined) return type;
  return resolveSubstitution(substitution, substitutions, new Set([...resolving, name]));
};

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

const unsafeSubstitution = (name, substitution, resolution) =>
  isUnappliedReferenceTo(substitution, name) ? null : unsafeDirectValue(substitution, resolution);

const unsafeDeclaredValue = (type, name, resolution) => {
  const declarations = resolution.environment.interfaces.get(name);
  if (declarations !== undefined) return isEmptyInterface(declarations) ? "empty-object" : null;
  const visit = aliasVisit(type, name, resolution);
  return visit === null ? null : unsafeDirectValue(visit.type, visit.resolution);
};

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

const unsafeCompositeValue = (type, resolution) => {
  if (type.type === "TSUnionType") {
    return type.types.some((member) => unsafeDirectValue(member, resolution) !== null)
      ? "union"
      : null;
  }
  if (type.type !== "TSIntersectionType") return null;
  const values = type.types.map((member) => unsafeDirectValue(member, resolution));
  if (values.includes("any")) return "any";
  return values.length > 0 && values.every((value) => value !== null) ? values[0] : null;
};

const unsafeDirectValue = (type, resolution) => {
  const unwrapped = unwrap(type);
  if (unwrapped.type === "TSUnknownKeyword") return "unknown";
  if (unwrapped.type === "TSAnyKeyword") return "any";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  if (unwrapped.type === "TSTypeLiteral" && isEmptyLiteral(unwrapped)) return "empty-object";
  if (unwrapped.type === "TSTypeReference") return unsafeReference(unwrapped, resolution);
  return unsafeCompositeValue(unwrapped, resolution);
};

const recordDictionaryValue = (type, resolution) => {
  const value = type.typeArguments?.params[1];
  return value === undefined ? [] : [{ type: value, substitutions: resolution.substitutions }];
};

const builtInDictionaryValues = (type, name, resolution) => {
  if (name === "Record") return recordDictionaryValue(type, resolution);
  if (TRANSPARENT_WRAPPERS.has(name) || name === "Pick" || name === "Omit") {
    const first = type.typeArguments?.params[0];
    return first === undefined ? [] : dictionaryValues(first, resolution);
  }
  return [];
};

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

const dictionaryValues = (type, resolution) => {
  const unwrapped = unwrap(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.flatMap((member) =>
      member.type === "TSIndexSignature" && member.typeAnnotation !== null
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

/** Classify an open object dictionary whose direct value contract is an escape hatch. */
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

/** Classify the direct value annotation on a standalone index signature. */
export const classifyUnsafeDictionaryValue = (type, environment) =>
  unsafeDirectValue(type, { environment, substitutions: new Map(), resolvingAliases: new Set() });
