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

/** Index local type declarations and names that shadow TypeScript utility types. */
export const createTypeEnvironment = (program) => {
  const aliases = new Map();
  const interfaces = new Map();
  const shadowedBuiltIns = new Set();

  for (const statement of program.body) {
    const declaration = declaredStatement(statement);
    if (declaration?.type === "ImportDeclaration") {
      for (const specifier of declaration.specifiers) {
        if (BUILT_INS.has(specifier.local.name)) shadowedBuiltIns.add(specifier.local.name);
      }
    } else if (declaration?.type === "TSTypeAliasDeclaration") {
      if (aliases.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
      else aliases.set(declaration.id.name, declaration);
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
    } else if (declaration?.type === "TSInterfaceDeclaration") {
      const declarations = interfaces.get(declaration.id.name) ?? [];
      declarations.push(declaration);
      interfaces.set(declaration.id.name, declarations);
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
    } else if (declaration?.id && BUILT_INS.has(declaration.id.name)) {
      shadowedBuiltIns.add(declaration.id.name);
    }
  }
  return { aliases, interfaces, shadowedBuiltIns };
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

const unsafeReference = (type, environment, substitutions, resolvingAliases) => {
  const name = referenceName(type);
  if (name === null) return null;
  const wrapped = type.typeArguments?.params[0];
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    return wrapped === undefined
      ? null
      : unsafeDirectValue(wrapped, environment, substitutions, resolvingAliases);
  }
  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? null
      : unsafeDirectValue(substitution, environment, substitutions, resolvingAliases);
  }
  const declarations = environment.interfaces.get(name);
  if (declarations !== undefined) return isEmptyInterface(declarations) ? "empty-object" : null;
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return null;
  const next = aliasSubstitutions(alias, type, substitutions);
  if (next === null) return null;
  return unsafeDirectValue(
    alias.typeAnnotation,
    environment,
    next,
    new Set([...resolvingAliases, name])
  );
};

const unsafeDirectValue = (type, environment, substitutions, resolvingAliases) => {
  const unwrapped = unwrap(type);
  if (unwrapped.type === "TSUnknownKeyword") return "unknown";
  if (unwrapped.type === "TSAnyKeyword") return "any";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  if (unwrapped.type === "TSTypeLiteral" && isEmptyLiteral(unwrapped)) return "empty-object";
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.some(
      (member) => unsafeDirectValue(member, environment, substitutions, resolvingAliases) !== null
    )
      ? "union"
      : null;
  }
  if (unwrapped.type === "TSIntersectionType") {
    const values = unwrapped.types.map((member) =>
      unsafeDirectValue(member, environment, substitutions, resolvingAliases)
    );
    if (values.includes("any")) return "any";
    return values.length > 0 && values.every((value) => value !== null) ? values[0] : null;
  }
  return unwrapped.type === "TSTypeReference"
    ? unsafeReference(unwrapped, environment, substitutions, resolvingAliases)
    : null;
};

const dictionaryReferenceValues = (type, environment, substitutions, resolvingAliases) => {
  const name = referenceName(type);
  if (name === null) return [];
  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? []
      : dictionaryValues(substitution, environment, substitutions, resolvingAliases);
  }
  const first = type.typeArguments?.params[0];
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    return first === undefined
      ? []
      : dictionaryValues(first, environment, substitutions, resolvingAliases);
  }
  if (name === "Record" && isBuiltIn(name, environment)) {
    const value = type.typeArguments?.params[1];
    return value === undefined ? [] : [{ type: value, substitutions }];
  }
  if ((name === "Pick" || name === "Omit") && isBuiltIn(name, environment)) {
    return first === undefined
      ? []
      : dictionaryValues(first, environment, substitutions, resolvingAliases);
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return [];
  const next = aliasSubstitutions(alias, type, substitutions);
  return next === null
    ? []
    : dictionaryValues(
        alias.typeAnnotation,
        environment,
        next,
        new Set([...resolvingAliases, name])
      );
};

const dictionaryValues = (type, environment, substitutions, resolvingAliases) => {
  const unwrapped = unwrap(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.flatMap((member) =>
      member.type === "TSIndexSignature" && member.typeAnnotation !== null
        ? [{ type: member.typeAnnotation.typeAnnotation, substitutions }]
        : []
    );
  }
  if (unwrapped.type === "TSMappedType") {
    return unwrapped.typeAnnotation === null
      ? []
      : [{ type: unwrapped.typeAnnotation, substitutions }];
  }
  return unwrapped.type === "TSTypeReference"
    ? dictionaryReferenceValues(unwrapped, environment, substitutions, resolvingAliases)
    : [];
};

/** Classify an open object dictionary whose direct value contract is an escape hatch. */
export const classifyUnsafeDictionary = (type, environment) => {
  for (const value of dictionaryValues(type, environment, new Map(), new Set())) {
    const unsafeValue = unsafeDirectValue(value.type, environment, value.substitutions, new Set());
    if (unsafeValue !== null) return unsafeValue;
  }
  return null;
};

/** Classify the direct value annotation on a standalone index signature. */
export const classifyUnsafeDictionaryValue = (type, environment) =>
  unsafeDirectValue(type, environment, new Map(), new Set());
