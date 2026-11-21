import * as Arr from "effect/Array";
import {
  type BigDecimal,
  type DateTime,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
  SchemaAST,
} from "effect";

type AtomicInput = DateTime.Utc | BigDecimal.BigDecimal | Option.Option<unknown>;

export type PartialInput<Value> = Value extends AtomicInput
  ? Value
  : Value extends ReadonlyArray<unknown>
    ? PartialArray<Value>
    : Value extends object
      ? { readonly [Key in keyof Value]?: PartialInput<Value[Key]> }
      : Value;

type TupleKeys<Value extends ReadonlyArray<unknown>> = Exclude<
  keyof Value,
  keyof ReadonlyArray<unknown>
>;

type IsTuple<Value extends ReadonlyArray<unknown>> = [TupleKeys<Value>] extends [never]
  ? Value extends readonly []
    ? true
    : Value extends readonly [unknown, ...ReadonlyArray<unknown>]
      ? true
      : Value extends readonly [...ReadonlyArray<unknown>, unknown]
        ? true
        : false
  : true;

type PartialArray<Value extends ReadonlyArray<unknown>> =
  IsTuple<Value> extends true
    ? { readonly [Key in keyof Value]: PartialInput<Value[Key]> }
    : ReadonlyArray<PartialInput<Value[number]>>;

type PartialInputSchema = Schema.Codec<unknown, unknown>;

const partialAnnotations = (
  annotations: Option.Option<Schema.Annotations.Annotations>
): Option.Option<Schema.Annotations.Annotations> =>
  annotations.pipe(
    Option.flatMap((present) =>
      Option.fromUndefinedOr(present.identifier).pipe(
        Option.filter(Predicate.isString),
        Option.map((identifier) => ({ ...present, identifier: `${identifier}Partial` }))
      )
    ),
    Option.orElse(() => annotations)
  );

const conditionalCheck = (
  check: SchemaAST.Check<unknown>,
  isComplete: (input: unknown) => boolean
): SchemaAST.Check<unknown> =>
  Match.valueTags(check, {
    FilterGroup: (group): SchemaAST.Check<unknown> =>
      new SchemaAST.FilterGroup(
        Arr.map(group.checks, (nested) => conditionalCheck(nested, isComplete)),
        group.annotations
      ),
    Filter: (filter): SchemaAST.Check<unknown> =>
      new SchemaAST.Filter(
        (input, self, options) =>
          isComplete(input) ? filter.run(input, self, options) : undefined,
        filter.annotations,
        filter.aborted
      ),
  });

const conditionalChecks = (
  checks: Option.Option<SchemaAST.Checks>,
  isComplete: (input: unknown) => boolean
): Option.Option<SchemaAST.Checks> =>
  Option.map(checks, (present) => Arr.map(present, (check) => conditionalCheck(check, isComplete)));

const fixedElementsComplete = (
  elements: ReadonlyArray<SchemaAST.AST>,
  input: ReadonlyArray<unknown>
): boolean =>
  elements.every((element, index) =>
    index < input.length ? isCompleteInput(element, input[index]) : SchemaAST.isOptional(element)
  );

const isCompleteArray = (ast: SchemaAST.Arrays, input: ReadonlyArray<unknown>): boolean => {
  if (!fixedElementsComplete(ast.elements, input)) return false;

  const [repeated, ...tail] = ast.rest;

  if (repeated === undefined) return input.length <= ast.elements.length;

  const tailStart = input.length - tail.length;

  return (
    tailStart >= ast.elements.length &&
    input.slice(ast.elements.length, tailStart).every((item) => isCompleteInput(repeated, item)) &&
    tail.every((element, index) => isCompleteInput(element, input[tailStart + index]))
  );
};

const numberIndexKey = /^[+-]?\d*\.?\d+(?:[Ee][+-]?\d+)?$|^(?:Infinity|-Infinity|NaN)$/;

const matchesIndexParameter = (
  parameter: SchemaAST.IndexSignature["parameter"],
  input: unknown
): boolean =>
  Result.isSuccess(
    Schema.decodeUnknownResult(Schema.make<Schema.Codec<unknown, unknown>>(parameter))(input)
  );

const matchesNumberIndexParameter = (parameter: SchemaAST.Number, key: string): boolean =>
  numberIndexKey.test(key) && matchesIndexParameter(parameter, Number(key));

type OwnKeys = Readonly<{ strings: ReadonlyArray<string>; symbols: ReadonlyArray<symbol> }>;

const matchingIndexKeys = (
  keys: OwnKeys,
  parameter: SchemaAST.IndexSignature["parameter"]
): ReadonlyArray<PropertyKey> =>
  Match.valueTags(parameter, {
    String: (string) => keys.strings.filter((key) => matchesIndexParameter(string, key)),
    TemplateLiteral: (template) =>
      keys.strings.filter((key) => matchesIndexParameter(template, key)),
    Number: (number) => keys.strings.filter((key) => matchesNumberIndexParameter(number, key)),
    Symbol: (symbol) => keys.symbols.filter((key) => matchesIndexParameter(symbol, key)),
    Union: (union): ReadonlyArray<PropertyKey> => [
      ...new Set(union.types.flatMap((member) => matchingIndexKeys(keys, member))),
    ],
  });

const isCompleteObjectInput = (ast: SchemaAST.Objects, input: unknown): boolean => {
  if (!Predicate.isObjectOrArray(input)) return false;

  const propertiesComplete = ast.propertySignatures.every((property) => {
    const isPresent = Object.hasOwn(input, property.name);

    if (SchemaAST.isOptional(property.type) && !isPresent) return true;

    return (
      isPresent &&
      isCompleteInput(property.type, Object.getOwnPropertyDescriptor(input, property.name)?.value)
    );
  });

  if (!propertiesComplete) return false;

  const keys: OwnKeys = {
    strings: Object.keys(input),
    symbols: Object.getOwnPropertySymbols(input),
  };

  const propertyNames = new Set(ast.propertySignatures.map((property) => property.name));

  return ast.indexSignatures.every((signature) =>
    matchingIndexKeys(keys, signature.parameter).every(
      (key) =>
        propertyNames.has(key) ||
        isCompleteInput(signature.type, Object.getOwnPropertyDescriptor(input, key)?.value)
    )
  );
};

const isCompleteArrayInput = (ast: SchemaAST.Arrays, input: unknown): boolean =>
  Array.isArray(input) && isCompleteArray(ast, input);

type AtomicCompleteness = (ast: SchemaAST.AST, input: unknown) => boolean;

const isCompleteLiteral: AtomicCompleteness = (ast, input) =>
  SchemaAST.isLiteral(ast) && Object.is(ast.literal, input);

const isCompleteUniqueSymbol: AtomicCompleteness = (ast, input) =>
  SchemaAST.isUniqueSymbol(ast) && Object.is(ast.symbol, input);

const isCompleteEnum: AtomicCompleteness = (ast, input) =>
  SchemaAST.isEnum(ast) && ast.enums.some(([, value]) => Object.is(value, input));

const atomicCompleteness: Partial<Record<SchemaAST.AST["_tag"], AtomicCompleteness>> = {
  Literal: isCompleteLiteral,
  String: (_, input) => Predicate.isString(input),
  TemplateLiteral: (ast, input) => Schema.is(Schema.make(ast))(input),
  Number: (_, input) => Predicate.isNumber(input),
  Boolean: (_, input) => Predicate.isBoolean(input),
  BigInt: (_, input) => Predicate.isBigInt(input),
  Symbol: (_, input) => Predicate.isSymbol(input),
  UniqueSymbol: isCompleteUniqueSymbol,
  Null: (_, input) => Predicate.isNull(input),
  Undefined: (_, input) => Predicate.isUndefined(input),
  Void: (_, input) => Predicate.isUndefined(input),
  Never: () => false,
  Enum: isCompleteEnum,
};

const isCompleteAtomic = (ast: SchemaAST.AST, input: unknown): boolean =>
  Option.fromUndefinedOr(atomicCompleteness[ast._tag]).pipe(
    Option.map((isComplete) => isComplete(ast, input)),
    Option.getOrElse(() => true)
  );

const isCompleteUnionMember = (member: SchemaAST.AST, input: unknown): boolean =>
  isCompleteInput(member, input) &&
  Result.isSuccess(
    Schema.decodeUnknownResult(Schema.make<Schema.Codec<unknown, unknown>>(member), {
      onExcessProperty: "error",
    })(input)
  );

const isCompleteInput = (ast: SchemaAST.AST, input: unknown): boolean => {
  if (SchemaAST.isObjects(ast)) return isCompleteObjectInput(ast, input);

  if (SchemaAST.isArrays(ast)) return isCompleteArrayInput(ast, input);

  if (SchemaAST.isUnion(ast)) {
    return ast.types.some((member) => isCompleteUnionMember(member, input));
  }

  if (SchemaAST.isSuspend(ast)) return isCompleteInput(ast.thunk(), input);

  return isCompleteAtomic(ast, input);
};

const partialArraysAst = (ast: SchemaAST.Arrays): SchemaAST.AST => {
  const isComplete = (input: unknown): boolean => isCompleteArrayInput(ast, input);

  return new SchemaAST.Arrays(
    ast.isMutable,
    ast.elements.map(partialInputAst),
    ast.rest.map(partialInputAst),
    Option.getOrUndefined(partialAnnotations(Option.fromUndefinedOr(ast.annotations))),
    Option.getOrUndefined(conditionalChecks(Option.fromUndefinedOr(ast.checks), isComplete)),
    ast.encoding,
    ast.context,
    Option.getOrUndefined(conditionalChecks(Option.fromUndefinedOr(ast.encodingChecks), isComplete))
  );
};

const partialUnionAst = (ast: SchemaAST.Union): SchemaAST.AST => {
  const isComplete = (input: unknown): boolean => isCompleteInput(ast, input);

  return new SchemaAST.Union(
    ast.types.map(partialInputAst),
    ast.options,
    Option.getOrUndefined(partialAnnotations(Option.fromUndefinedOr(ast.annotations))),
    Option.getOrUndefined(conditionalChecks(Option.fromUndefinedOr(ast.checks), isComplete)),
    ast.encoding,
    ast.context,
    Option.getOrUndefined(conditionalChecks(Option.fromUndefinedOr(ast.encodingChecks), isComplete))
  );
};

const partialSuspendAst = (ast: SchemaAST.Suspend): SchemaAST.AST =>
  new SchemaAST.Suspend(
    () => partialInputAst(ast.thunk()),
    Option.getOrUndefined(partialAnnotations(Option.fromUndefinedOr(ast.annotations))),
    undefined,
    ast.encoding,
    ast.context
  );

const partialObjectsAst = (ast: SchemaAST.Objects): SchemaAST.AST => {
  const isComplete = (input: unknown): boolean => isCompleteInput(ast, input);

  return new SchemaAST.Objects(
    ast.propertySignatures.map(
      (property) =>
        new SchemaAST.PropertySignature(
          property.name,
          Schema.optionalKey(Schema.make(partialInputAst(property.type))).ast
        )
    ),
    ast.indexSignatures.map(
      (signature) =>
        new SchemaAST.IndexSignature(signature.parameter, partialInputAst(signature.type))
    ),
    Option.getOrUndefined(partialAnnotations(Option.fromUndefinedOr(ast.annotations))),
    Option.getOrUndefined(conditionalChecks(Option.fromUndefinedOr(ast.checks), isComplete)),
    ast.encoding,
    ast.context,
    Option.getOrUndefined(conditionalChecks(Option.fromUndefinedOr(ast.encodingChecks), isComplete))
  );
};

const rewrittenPartialAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (SchemaAST.isArrays(ast)) return partialArraysAst(ast);

  if (SchemaAST.isUnion(ast)) return partialUnionAst(ast);

  if (SchemaAST.isSuspend(ast)) return partialSuspendAst(ast);

  if (SchemaAST.isObjects(ast)) return partialObjectsAst(ast);

  return ast;
};

const partialAstCache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

const partialInputAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  const cached = partialAstCache.get(ast);

  if (cached !== undefined) return cached;
  const partial = rewrittenPartialAst(ast);
  partialAstCache.set(ast, partial);

  return partial;
};

export const makePartialInputSchema = (schema: Schema.Top): PartialInputSchema =>
  Schema.make<PartialInputSchema>(partialInputAst(schema.ast));
