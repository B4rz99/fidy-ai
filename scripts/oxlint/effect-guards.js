// Custom oxlint JS plugin: Effect/SQL semantic guards that oxlint's built-in
// rules and @effect/language-service diagnostics do not already cover.
//
// Ported from the bespoke ESLint rules in
// https://github.com/mikearnaldi/accountability/blob/main/eslint.config.mjs
//
// oxlint's JS-plugin API mirrors ESLint v9. Written in .js so tsgo (which only
// typechecks *.ts) does not try to typecheck the untyped plugin API.

import {
  classifyUnsafeDictionary,
  classifyUnsafeDictionaryValue,
  createTypeEnvironment,
} from "./dictionary-types.js";

/**
 * Ban `sql<Type>`...`` — a type parameter on a sql tagged template provides no
 * runtime validation. Use SqlSchema.findOne/findAll/single/void with a Schema
 * so queries validate at runtime.
 */
const noSqlTypeParameter = {
  meta: {
    type: "problem",
    docs: { description: "Disallow type parameters on sql tagged templates" },
    messages: {
      noSqlTypeParam:
        "Do not use sql<Type>`...`. Type parameters provide no runtime validation. Use SqlSchema.findOne/findAll/single/void with a Schema for queries that validate at runtime.",
    },
    schema: [],
  },
  create(context) {
    return {
      TaggedTemplateExpression(node) {
        // Oxc exposes `typeArguments`; older ESTree used `typeParameters`.
        if (!node.typeArguments && !node.typeParameters) return;
        const tag = node.tag;
        const isSql =
          (tag.type === "Identifier" && tag.name === "sql") ||
          (tag.type === "MemberExpression" &&
            tag.property.type === "Identifier" &&
            tag.property.name === "sql");
        if (isSql) {
          context.report({ node, messageId: "noSqlTypeParam" });
        }
      },
    };
  },
};

/**
 * Ban `{ disableValidation: true }` — disabling Schema validation defeats the
 * purpose of Schema and hides invalid data. Fix the data or the schema instead.
 */
const noDisableValidation = {
  meta: {
    type: "problem",
    docs: { description: "Disallow disableValidation: true in Schema operations" },
    messages: {
      noDisableValidation:
        "Do not use { disableValidation: true }. Schema validation should always be enabled. Fix the data or the schema instead of disabling validation.",
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        const key = node.key;
        const isDisableValidationKey =
          (key.type === "Identifier" && key.name === "disableValidation") ||
          (key.type === "Literal" && key.value === "disableValidation");
        if (isDisableValidationKey && node.value.type === "Literal" && node.value.value === true) {
          context.report({ node, messageId: "noDisableValidation" });
        }
      },
    };
  },
};

// The Effect constructors that take an arbitrary thunk or promise and hand back
// an Effect without putting anything in `R`. See ARCHITECTURE.md §3. `async` is
// the v3 spelling of `callback`; both are listed so the fence survives either.
const ESCAPE_HATCHES = new Set(["sync", "promise", "tryPromise", "async", "callback"]);

const isWholeModuleImport = (specifier) =>
  specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier";

const bindsEffectNamespace = (source, specifier) =>
  (source === "effect/Effect" && isWholeModuleImport(specifier)) ||
  (source === "effect" && importsName(specifier, "Effect"));

/**
 * Reject `Effect.promise`, whose `never` failure channel turns an unexpected Promise rejection into
 * a defect. Production adapters use `Effect.tryPromise` and then deliberately map, contain, or die
 * on the foreign failure. This keeps the exceptional decision visible at the interop site.
 */
const noEffectPromise = {
  meta: {
    type: "problem",
    docs: { description: "Disallow Effect.promise in production application source" },
    messages: {
      noEffectPromise:
        "Do not use Effect.promise. A rejected Promise becomes a defect despite the Effect's `never` failure channel. Use Effect.tryPromise and deliberately map the rejection to a typed failure, contain it, or use orDie only when rejection is truly a defect.",
    },
    schema: [],
  },
  create(context) {
    const effectNamespaces = new Set(["Effect"]);
    return {
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || !effectNamespaces.has(node.object.name)) return;
        if (staticMemberName(node) !== "promise") return;
        context.report({ node, messageId: "noEffectPromise" });
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        if (source !== "effect" && source !== "effect/Effect") return;
        for (const specifier of node.specifiers) {
          if (bindsEffectNamespace(source, specifier)) effectNamespaces.add(specifier.local.name);
          if (!importsName(specifier, "promise")) continue;
          context.report({ node: specifier, messageId: "noEffectPromise" });
        }
      },
    };
  },
};

/** Rejects type-only cast helpers that suppress assignability errors without runtime proof. */
const noTypeCast = {
  meta: {
    type: "problem",
    docs: { description: "Disallow type-only cast helpers" },
    messages: {
      noTypeCast:
        "Do not call cast helpers. Preserve the type relationship in the module interface or validate the value at runtime.",
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (staticMemberName(node) === "cast") {
          context.report({ node, messageId: "noTypeCast" });
        }
      },
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          if (specifier.imported.type === "Identifier" && specifier.imported.name === "cast") {
            context.report({ node: specifier, messageId: "noTypeCast" });
          }
        }
      },
    };
  },
};

/** The member name a `.prop` or `["prop"]` access reads, or undefined. */
const staticMemberName = (node) => {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.property.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
  return undefined;
};

/**
 * Ban the Effect escape hatches. `Effect.sync`, `Effect.promise`,
 * `Effect.tryPromise` and `Effect.callback`/`async` accept an arbitrary thunk
 * and produce an `Effect` with `R = never`, so a vendor SDK call reached
 * through one of them never appears in the requirements channel. Scoped to
 * `apps/server/src/core/**` by the config: they are the last remaining way to do I/O in the
 * functional core without the type noticing.
 */
const noEscapeHatch = {
  meta: {
    type: "problem",
    docs: { description: "Disallow the Effect escape-hatch constructors" },
    messages: {
      noEscapeHatch:
        "Do not use Effect.{{name}} here. It builds an Effect with R = never from an arbitrary thunk, so I/O reached through it never appears in the requirements channel. Take the value as a parameter and let the shell supply it, or move the operation to shell/.",
    },
    schema: [],
  },
  create(context) {
    return {
      // `Effect.sync(...)` — the repo idiom is `import { Effect } from "effect"`.
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || node.object.name !== "Effect") return;
        const name = staticMemberName(node);
        if (name === undefined || !ESCAPE_HATCHES.has(name)) return;
        context.report({ node, messageId: "noEscapeHatch", data: { name } });
      },
      // `import { sync } from "effect/Effect"` — the same hatch, unqualified.
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        if (source !== "effect" && !source.startsWith("effect/")) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = specifier.imported;
          if (imported.type !== "Identifier" || !ESCAPE_HATCHES.has(imported.name)) continue;
          context.report({
            node: specifier,
            messageId: "noEscapeHatch",
            data: { name: imported.name },
          });
        }
      },
    };
  },
};

/**
 * Index a module's top-level statements by the names they bind, as `bindingsOf`
 * reports them. Nameless entries are dropped: nothing can refer to them by name.
 */
const indexByName = (program, bindingsOf) =>
  new Map(program.body.flatMap(bindingsOf).filter(([name]) => name !== undefined));

/**
 * The `[specifier, local name]` pairs a bare `export { a, b as c }` carries.
 * ESTree always supplies `specifiers` on that form, so it is read directly: a
 * statement missing it is a shape that cannot occur, and it should fail here
 * rather than quietly walk an empty list and report nothing.
 */
const exportedLocals = (statement) =>
  statement.specifiers.flatMap((specifier) =>
    specifier.type === "ExportSpecifier" && specifier.local.type === "Identifier"
      ? [[specifier, specifier.local.name]]
      : []
  );

/** The leftmost identifier of a `typeof X` / `typeof X.Y` query, or undefined. */
const typeQueryRoot = (typeAnnotation) => {
  if (typeAnnotation?.type !== "TSTypeQuery") return undefined;
  let name = typeAnnotation.exprName;
  while (name?.type === "TSQualifiedName") name = name.left;
  return name?.type === "Identifier" ? name.name : undefined;
};

/**
 * A `export type X = typeof X.Type` restating a schema declared just above it.
 * The Effect idiom pairs every schema with its inferred type under one name;
 * they are one interface, documented once on the schema. Demanding a second
 * comment here would only produce the comment-shaped text that says nothing.
 */
const isSchemaTypeCompanion = (declaration) =>
  declaration.type === "TSTypeAliasDeclaration" &&
  declaration.id.type === "Identifier" &&
  typeQueryRoot(declaration.typeAnnotation) === declaration.id.name;

/** The names one top-level statement binds, each paired with the statement itself. */
const declaredBindings = (statement) => {
  if (statement.type === "VariableDeclaration") {
    return statement.declarations.flatMap((declarator) =>
      declarator.id.type === "Identifier" ? [[declarator.id.name, statement]] : []
    );
  }
  return statement.id?.type === "Identifier" ? [[statement.id.name, statement]] : [];
};

/**
 * Require a leading block comment on every exported declaration. Scoped to
 * `apps/server/src/core/**` by the config: core is what shell consumes, so its exports are
 * the interfaces, and enforcing presence everywhere reliably produces
 * comment-shaped text that satisfies a linter and says nothing.
 *
 * Presence only. Quality — whether a caller could use the thing having read the
 * comment and the signature and never the body — stays a review matter
 * (CODING_STANDARDS.md).
 *
 * A bare `export { name }` is judged on the comment above the declaration of
 * `name`, not on the export line. The interface is documented where it is
 * declared, and demanding a second comment above a list of names is how a rule
 * about interfaces starts producing text about nothing.
 */
const requireInterfaceComment = {
  meta: {
    type: "problem",
    docs: { description: "Require a leading block comment on exported declarations" },
    messages: {
      requireInterfaceComment:
        "This export has no leading block comment. Core is what shell consumes, so its exports are the interfaces: say what the abstraction does, what the arguments mean beyond their types, what the caller must guarantee and what it may rely on afterwards. A caller should be able to use it correctly having read the comment and the signature and never the body.",
    },
    schema: [],
  },
  create(context) {
    const lacksLeadingBlockComment = (node) => {
      const comments = context.sourceCode.getCommentsBefore(node);
      const nearest = comments.at(-1);
      return nearest === undefined || nearest.type !== "Block" || nearest.value.trim() === "";
    };
    const report = (node) => context.report({ node, messageId: "requireInterfaceComment" });

    const checkSpecifiers = (statement, sites) => {
      for (const [specifier, name] of exportedLocals(statement)) {
        const site = sites.get(name);
        // A name this module does not declare arrived by import, documented
        // wherever it came from.
        if (site === undefined || isSchemaTypeCompanion(site)) continue;
        if (lacksLeadingBlockComment(site)) report(specifier);
      }
    };

    const checkNamed = (statement, sites) => {
      // `export { x } from "./y"` re-exports something already documented
      // where it is declared; the barrel-file rule in .dependency-cruiser.mjs
      // is what keeps those from becoming a habit.
      if (statement.source) return;
      if (!statement.declaration) return checkSpecifiers(statement, sites);
      if (isSchemaTypeCompanion(statement.declaration)) return;
      if (lacksLeadingBlockComment(statement)) report(statement);
    };

    return {
      Program(program) {
        /** Where each name in the module is declared, for the `export { name }` case. */
        const sites = indexByName(program, declaredBindings);
        for (const statement of program.body) {
          if (statement.type === "ExportNamedDeclaration") checkNamed(statement, sites);
          if (
            statement.type === "ExportDefaultDeclaration" &&
            lacksLeadingBlockComment(statement)
          ) {
            report(statement);
          }
        }
      },
    };
  },
};

/**
 * Ban direct use of React's useEffect. UI work is caused by an event, derived
 * during render, or owned by a dedicated query/router/external-store API; a
 * state transition must never be used as an indirect command. If a concrete
 * imperative integration eventually requires synchronization, it belongs in
 * one narrow adapter with an explicit file-scoped lint exception.
 */
const noReactUseEffect = {
  meta: {
    type: "problem",
    docs: { description: "Disallow direct use of React useEffect" },
    messages: {
      noReactUseEffect:
        "Do not use React useEffect. Derive presentation during render, perform commands in event handlers, and use the owning query, router, or external-store API for synchronization.",
    },
    schema: [],
  },
  create(context) {
    const reactNamespaces = new Set();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "react") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            (specifier.imported.name === "useEffect" || specifier.imported.value === "useEffect")
          ) {
            context.report({ node: specifier, messageId: "noReactUseEffect" });
          }
          if (
            specifier.type === "ImportDefaultSpecifier" ||
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            reactNamespaces.add(specifier.local.name);
          }
        }
      },
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || !reactNamespaces.has(node.object.name)) return;
        if (staticMemberName(node) !== "useEffect") return;
        context.report({ node, messageId: "noReactUseEffect" });
      },
    };
  },
};

/**
 * DateTime.Utc exposes `partsUtc` only as Effect's mutable lazy cache. Core may
 * carry Utc instants but must never couple domain logic to that internal field.
 */
const noDateTimeInternals = {
  meta: {
    type: "problem",
    docs: { description: "Disallow access to Effect DateTime mutable internals" },
    messages: {
      noDateTimeInternals:
        "Do not access DateTime.partsUtc. It is Effect's mutable internal cache, not domain state.",
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (staticMemberName(node) === "partsUtc") {
          context.report({ node, messageId: "noDateTimeInternals" });
        }
      },
    };
  },
};

const SCALAR_SCHEMA_CONSTRUCTORS = new Set([
  "BigInt",
  "BigIntFromSelf",
  "Boolean",
  "Finite",
  "Int",
  "Literal",
  "Literals",
  "NonEmptyString",
  "Number",
  "String",
  "Symbol",
  "TemplateLiteral",
]);

/** The Schema constructor at the root of a fluent schema expression. */
const schemaConstructorName = (expression, schemaNamespaces) => {
  let current = expression;
  while (current !== undefined) {
    if (current.type === "ChainExpression") {
      current = current.expression;
      continue;
    }
    if (current.type === "CallExpression") {
      current = current.callee;
      continue;
    }
    if (current.type !== "MemberExpression") return undefined;
    if (current.object.type === "Identifier" && schemaNamespaces.has(current.object.name)) {
      return staticMemberName(current);
    }
    current = current.object;
  }
  return undefined;
};

const importsName = (specifier, name) =>
  specifier.type === "ImportSpecifier" &&
  (specifier.imported.name === name || specifier.imported.value === name);

const schemaNamespaceLocals = (node) => {
  if (node.source.value === "effect") {
    return node.specifiers
      .filter((specifier) => importsName(specifier, "Schema"))
      .map((specifier) => specifier.local.name);
  }
  if (node.source.value === "effect/Schema") {
    return node.specifiers
      .filter((specifier) => specifier.type === "ImportNamespaceSpecifier")
      .map((specifier) => specifier.local.name);
  }
  return [];
};

const brandBindingLocals = (node) =>
  node.source.value === "effect/Schema"
    ? node.specifiers
        .filter((specifier) => importsName(specifier, "brand"))
        .map((specifier) => specifier.local.name)
    : [];

/**
 * Effect's Brand type is allowed through the deep-readonly rule because its
 * phantom variance field is misclassified as mutable. Compensate by permitting
 * Schema.brand only when the branded runtime value is a primitive scalar.
 */
const scalarBrandOnly = {
  meta: {
    type: "problem",
    docs: { description: "Permit Effect Schema brands only on scalar schemas" },
    messages: {
      scalarBrandOnly:
        "Schema.brand may only brand a scalar schema. Branded objects make the Brand readonly allowance hide mutable domain state.",
    },
    schema: [],
  },
  create(context) {
    const schemaNamespaces = new Set(["Schema"]);
    const directBrandBindings = new Set();

    const isBrandCall = (node) => {
      if (node.callee.type === "Identifier") return directBrandBindings.has(node.callee.name);
      return (
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        schemaNamespaces.has(node.callee.object.name) &&
        staticMemberName(node.callee) === "brand"
      );
    };

    return {
      ImportDeclaration(node) {
        for (const local of schemaNamespaceLocals(node)) schemaNamespaces.add(local);
        for (const local of brandBindingLocals(node)) directBrandBindings.add(local);
      },
      CallExpression(node) {
        if (!isBrandCall(node)) return;
        const pipeCall = node.parent;
        if (
          pipeCall?.type !== "CallExpression" ||
          pipeCall.callee.type !== "MemberExpression" ||
          staticMemberName(pipeCall.callee) !== "pipe"
        ) {
          context.report({ node, messageId: "scalarBrandOnly" });
          return;
        }
        const constructor = schemaConstructorName(pipeCall.callee.object, schemaNamespaces);
        if (constructor === undefined || !SCALAR_SCHEMA_CONSTRUCTORS.has(constructor)) {
          context.report({ node, messageId: "scalarBrandOnly" });
        }
      },
    };
  },
};

const ENTROPY_EXPORTS = new Set([
  "generateKey",
  "generateKeyPair",
  "generateKeyPairSync",
  "generateKeySync",
  "generatePrime",
  "generatePrimeSync",
  "getRandomValues",
  "randomBytes",
  "randomFill",
  "randomFillSync",
  "randomInt",
  "randomUUID",
]);

const CRYPTO_SOURCES = new Set(["crypto", "node:crypto"]);

const bindsWholeModule = (specifier) =>
  specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier";

const cryptoModuleLocals = (statement) => {
  if (statement.type !== "ImportDeclaration") return [];
  const source = statement.source.value;
  if (typeof source !== "string" || !CRYPTO_SOURCES.has(source)) return [];
  return statement.specifiers.filter(bindsWholeModule).map((specifier) => specifier.local.name);
};

const cryptoBindings = (program) =>
  new Set(["crypto", ...program.body.flatMap(cryptoModuleLocals)]);

const isCryptoObject = (object, names) => {
  if (object.type === "Identifier") return names.has(object.name);
  return object.type === "MemberExpression" && staticMemberName(object) === "crypto";
};

const noAmbientNondeterminism = {
  meta: {
    type: "problem",
    docs: { description: "Disallow ambient clock and entropy reads in core" },
    messages: {
      clock:
        "core may not read the clock. `new Date()` with no arguments reads it as surely as Date.now() does, and types as a plain value so nothing else in the toolchain can see it. Take the timestamp as a parameter and let the shell call Clock. `new Date(value)` is fine — that parses what the caller gave you.",
      random:
        "core may not be random. `{{name}}` draws entropy, so the same inputs stop producing the same output. node:crypto is permitted in core for hashing only (`createHash`/`createHmac`, which are deterministic). Take the value as a parameter and let the shell generate it.",
    },
    schema: [],
  },
  create(context) {
    const reportRandom = (node, name) =>
      context.report({ node, messageId: "random", data: { name } });
    const cryptoNames = new Set(["crypto"]);
    return {
      Program(program) {
        for (const name of cryptoBindings(program)) cryptoNames.add(name);
      },
      NewExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "Date") return;
        if (node.arguments.length > 0) return;
        context.report({ node, messageId: "clock" });
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string" || !CRYPTO_SOURCES.has(source)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = specifier.imported;
          if (imported.type !== "Identifier" || !ENTROPY_EXPORTS.has(imported.name)) continue;
          reportRandom(specifier, imported.name);
        }
      },
      MemberExpression(node) {
        const name = staticMemberName(node);
        if (name === undefined || !ENTROPY_EXPORTS.has(name)) return;
        if (!isCryptoObject(node.object, cryptoNames)) return;
        reportRandom(node, name);
      },
    };
  },
};

const parameterAnnotation = (parameter) => {
  if (parameter.type === "TSParameterProperty") return parameterAnnotation(parameter.parameter);
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
};

/**
 * Core accepts established contracts. Raw values must be decoded before they
 * cross the core boundary unless a validation module is recorded as a narrow
 * config-level exception.
 */
const noUnknownParameters = {
  meta: {
    type: "problem",
    docs: { description: "Disallow explicitly unknown parameters in core" },
    messages: {
      unknownParameter:
        "Core may not accept an `unknown` parameter. Decode raw input at its boundary or replace it with the narrowest honest input contract. A genuine core validation module must be recorded as a narrow override in .oxlintrc.json.",
    },
    schema: [],
  },
  create(context) {
    const check = (node) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type === "TSUnknownKeyword") {
          context.report({ node: annotation.typeAnnotation, messageId: "unknownParameter" });
        }
      }
    };
    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
      TSCallSignatureDeclaration: check,
      TSConstructSignatureDeclaration: check,
      TSConstructorType: check,
      TSDeclareFunction: check,
      TSEmptyBodyFunctionExpression: check,
      TSFunctionType: check,
      TSMethodSignature: check,
    };
  },
};

const isTypeNode = (node) => node.type.startsWith("TS") && node.type !== "TSTypeAnnotation";

const hasUnsafeDictionaryAncestor = (node, environment) => {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isTypeNode(current) && classifyUnsafeDictionary(current, environment) !== null) return true;
    current = current.parent;
  }
  return false;
};

const isInsideTypeAlias = (node) => {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (current.type === "TSTypeAliasDeclaration") return true;
    current = current.parent;
  }
  return false;
};

const isPlainAliasConsumer = (node, environment) =>
  node.type === "TSTypeReference" &&
  node.typeName.type === "Identifier" &&
  (node.typeArguments?.params.length ?? 0) === 0 &&
  environment.aliases.has(node.typeName.name) &&
  !isInsideTypeAlias(node);

/** Reject open object dictionaries whose values have no established contract. */
const noUnsafeDictionaryType = {
  meta: {
    type: "problem",
    docs: { description: "Disallow unsafe open dictionary value contracts in core" },
    messages: {
      unsafeDictionary:
        "This core dictionary uses `{{value}}` as its direct value contract. Use a concrete owner/schema-derived value type; known fixture fields should use a named shape with Partial<T> overrides.",
    },
    schema: [],
  },
  create(context) {
    let environment;
    const reportType = (node) => {
      if (environment === undefined || isPlainAliasConsumer(node, environment)) return;
      if (hasUnsafeDictionaryAncestor(node, environment)) return;
      const value = classifyUnsafeDictionary(node, environment);
      if (value !== null) {
        context.report({ node, messageId: "unsafeDictionary", data: { value } });
      }
    };
    return {
      Program(node) {
        environment = createTypeEnvironment(node);
      },
      TSTypeReference: reportType,
      TSTypeLiteral: reportType,
      TSMappedType: reportType,
      TSIndexSignature(node) {
        if (environment === undefined || node.typeAnnotation === null) return;
        if (node.parent.type === "TSTypeLiteral") return;
        const value = classifyUnsafeDictionaryValue(
          node.typeAnnotation.typeAnnotation,
          environment
        );
        if (value !== null) {
          context.report({ node, messageId: "unsafeDictionary", data: { value } });
        }
      },
    };
  },
};

const noNullableType = {
  meta: {
    type: "problem",
    docs: { description: "Disallow undefined/null in types; absence is Option" },
    messages: {
      keyword:
        '`{{name}}` in a type makes absence a value every read has to be talked out of, and `?? fallback` the cheapest way to do it. Use `Option.Option<T>`: `Option.fromNullable`/`Option.fromUndefinedOr` where a builtin hands one back, `Schema.OptionFromNullOr` or `Schema.optionalWith(…, { as: "Option" })` in a schema — the wire keeps its `null`, only the decoded type changes. Effect\'s own lookups (`Array.get`, `Array.findFirst`, `Array.last`, `String.match`, `HashMap.get`) return Options and never produce this.',
      optional:
        "An optional property makes absence a missing key, which reads back as `T | undefined` — the same defect one spelling further out. Make it required and `Option.Option<T>`, so the empty case is handled at the read rather than defaulted at it.",
    },
    schema: [],
  },
  create(context) {
    const keyword = (name) => (node) =>
      context.report({ node, messageId: "keyword", data: { name } });
    return {
      TSUndefinedKeyword: keyword("undefined"),
      TSNullKeyword: keyword("null"),
      TSPropertySignature(node) {
        if (node.optional === true) context.report({ node, messageId: "optional" });
      },
    };
  },
};

const plugin = {
  meta: { name: "effect-guards" },
  rules: {
    "no-ambient-nondeterminism": noAmbientNondeterminism,
    "no-type-cast": noTypeCast,
    "no-nullable-type": noNullableType,
    "no-unknown-parameters": noUnknownParameters,
    "no-unsafe-dictionary-type": noUnsafeDictionaryType,
    "no-react-use-effect": noReactUseEffect,
    "no-sql-type-parameter": noSqlTypeParameter,
    "no-disable-validation": noDisableValidation,
    "no-escape-hatch": noEscapeHatch,
    "no-effect-promise": noEffectPromise,
    "no-datetime-internals": noDateTimeInternals,
    "require-interface-comment": requireInterfaceComment,
    "scalar-brand-only": scalarBrandOnly,
  },
};

export default plugin;
