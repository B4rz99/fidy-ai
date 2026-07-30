import * as Arr from "effect/Array";
import {
  type BigDecimal,
  type DateTime,
  Option,
  Predicate,
  Result,
  Schema,
  SchemaAST,
} from "effect";

/** Values whose internal object representation is not part of a partial operation input. */
type AtomicInput = DateTime.Utc | BigDecimal.BigDecimal | Option.Option<unknown>;

/**
 * The values a handler may already know for a target operation input. Object
 * properties become optional recursively, arrays retain their cardinality
 * semantics, and atomic declarations remain indivisible.
 */
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
  annotations: Schema.Annotations.Annotations | undefined
): Schema.Annotations.Annotations | undefined =>
  Option.fromUndefinedOr(annotations).pipe(
    Option.flatMap((present) =>
      Option.fromUndefinedOr(present.identifier).pipe(
        Option.filter(Predicate.isString),
        Option.map((identifier) => ({ ...present, identifier: `${identifier}Partial` }))
      )
    ),
    Option.getOrElse(() => annotations)
  );

const conditionalCheck = (
  check: SchemaAST.Check<unknown>,
  isComplete: (input: unknown) => boolean
): SchemaAST.Check<unknown> => {
  if (check._tag === "FilterGroup") {
    return new SchemaAST.FilterGroup(
      Arr.map(check.checks, (nested) => conditionalCheck(nested, isComplete)),
      check.annotations
    );
  }
  return new SchemaAST.Filter(
    (input, self, options) => (isComplete(input) ? check.run(input, self, options) : undefined),
    check.annotations,
    check.aborted
  );
};

const conditionalChecks = (
  checks: SchemaAST.Checks | undefined,
  isComplete: (input: unknown) => boolean
): SchemaAST.Checks | undefined =>
  checks === undefined
    ? undefined
    : Arr.map(checks, (check) => conditionalCheck(check, isComplete));

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

const matchingIndexKeys = (
  input: object,
  parameter: SchemaAST.IndexSignature["parameter"]
): ReadonlyArray<PropertyKey> => {
  switch (parameter._tag) {
    case "String":
    case "TemplateLiteral":
      return Object.keys(input).filter((key) => matchesIndexParameter(parameter, key));
    case "Number":
      return Object.keys(input).filter((key) => matchesNumberIndexParameter(parameter, key));
    case "Symbol":
      return Object.getOwnPropertySymbols(input).filter((key) =>
        matchesIndexParameter(parameter, key)
      );
    case "Union":
      return [...new Set(parameter.types.flatMap((member) => matchingIndexKeys(input, member)))];
  }
};

const isCompleteObject = (ast: SchemaAST.Objects, input: object): boolean => {
  const propertiesComplete = ast.propertySignatures.every((property) => {
    const isPresent = Object.hasOwn(input, property.name);
    if (SchemaAST.isOptional(property.type) && !isPresent) return true;
    return isPresent && isCompleteInput(property.type, Reflect.get(input, property.name));
  });
  if (!propertiesComplete) return false;

  const propertyNames = new Set(ast.propertySignatures.map((property) => property.name));
  return ast.indexSignatures.every((signature) =>
    matchingIndexKeys(input, signature.parameter).every(
      (key) => propertyNames.has(key) || isCompleteInput(signature.type, Reflect.get(input, key))
    )
  );
};

const isCompleteObjectInput = (ast: SchemaAST.Objects, input: unknown): boolean =>
  Predicate.isObjectOrArray(input) ? isCompleteObject(ast, input) : false;

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
  if (ast._tag === "Objects") return isCompleteObjectInput(ast, input);
  if (ast._tag === "Arrays") return isCompleteArrayInput(ast, input);
  if (ast._tag === "Union") {
    return ast.types.some((member) => isCompleteUnionMember(member, input));
  }
  if (ast._tag === "Suspend") return isCompleteInput(ast.thunk(), input);
  return isCompleteAtomic(ast, input);
};

const partialAstCache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

const partialInputAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  const cached = partialAstCache.get(ast);
  if (cached !== undefined) return cached;
  const remember = (partial: SchemaAST.AST): SchemaAST.AST => {
    partialAstCache.set(ast, partial);
    return partial;
  };

  switch (ast._tag) {
    case "Arrays": {
      const isComplete = (input: unknown): boolean => isCompleteArrayInput(ast, input);
      return remember(
        new SchemaAST.Arrays(
          ast.isMutable,
          ast.elements.map(partialInputAst),
          ast.rest.map(partialInputAst),
          partialAnnotations(ast.annotations),
          conditionalChecks(ast.checks, isComplete),
          ast.encoding,
          ast.context,
          conditionalChecks(ast.encodingChecks, isComplete)
        )
      );
    }
    case "Union": {
      const isComplete = (input: unknown): boolean => isCompleteInput(ast, input);
      return remember(
        new SchemaAST.Union(
          ast.types.map(partialInputAst),
          ast.mode,
          partialAnnotations(ast.annotations),
          conditionalChecks(ast.checks, isComplete),
          ast.encoding,
          ast.context,
          conditionalChecks(ast.encodingChecks, isComplete)
        )
      );
    }
    case "Suspend": {
      const partial = new SchemaAST.Suspend(
        () => partialInputAst(ast.thunk()),
        partialAnnotations(ast.annotations),
        undefined,
        ast.encoding,
        ast.context
      );
      partialAstCache.set(ast, partial);
      return partial;
    }
    case "Objects": {
      const isComplete = (input: unknown): boolean => isCompleteInput(ast, input);

      return remember(
        new SchemaAST.Objects(
          ast.propertySignatures.map(
            (property) =>
              new SchemaAST.PropertySignature(
                property.name,
                Schema.optionalKey(Schema.make(partialInputAst(property.type))).ast
              )
          ),
          ast.indexSignatures.map(
            (signature) =>
              new SchemaAST.IndexSignature(
                signature.parameter,
                partialInputAst(signature.type),
                signature.merge
              )
          ),
          partialAnnotations(ast.annotations),
          conditionalChecks(ast.checks, isComplete),
          ast.encoding,
          ast.context,
          conditionalChecks(ast.encodingChecks, isComplete)
        )
      );
    }
    case "Declaration":
    case "Null":
    case "Undefined":
    case "Void":
    case "Never":
    case "Any":
    case "Unknown":
    case "ObjectKeyword":
    case "Enum":
    case "TemplateLiteral":
    case "UniqueSymbol":
    case "Literal":
    case "String":
    case "Number":
    case "Boolean":
    case "Symbol":
    case "BigInt":
      return remember(ast);
  }
};

/**
 * Derives the runtime schema matching `PartialInput`: supplied values retain
 * their canonical codecs and checks, while object checks wait only for omitted
 * required input.
 */
export const makePartialInputSchema = (schema: Schema.Top): PartialInputSchema =>
  Schema.make<PartialInputSchema>(partialInputAst(schema.ast));
