#!/usr/bin/env bun

import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import * as Babel from "@babel/types";
import { Effect, Option } from "effect";

/**
 * Every production redacted credential must have one focused test proving its adapter path keeps the
 * secret out of failures, logs, and model context. Direct reads and the shared credential loaders
 * (`configuredSecret`, `configuredHmacKey`) carry the same obligation, and the pairing is stated
 * here rather than inferred, so adding a credential without that evidence fails the gate instead of
 * shipping unproven. The scan rejects any non-literal loader use rather than skipping it.
 */
type CredentialEvidence = Readonly<{
  configuration: string;
  testFile: string;
  testName: string;
}>;

const credentialEvidence = [
  {
    configuration: "OPENAI_API_KEY",
    testFile: "apps/server/src/shell/agent/openai.test.ts",
    testName: "counts complete framing and executes the exact prepared request",
  },
  {
    configuration: "MISTRAL_API_KEY",
    testFile: "apps/server/src/shell/agent/mistral-conformance.test.ts",
    testName: "fails without exposing the credential or provider body",
  },
  {
    configuration: "EMAIL_ADMISSION_HMAC_KEY",
    testFile: "apps/server/src/shell/onboarding/onboarding-turn.test.ts",
    testName: "keeps the email admission HMAC credential out of persistence and outcomes",
  },
  {
    configuration: "EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY",
    testFile: "apps/server/src/shell/email-authentication/replacement.test.ts",
    testName: "keeps the credential lookup HMAC key out of persistence and outcomes",
  },
  {
    configuration: "SOURCE_ADMISSION_HMAC_KEY",
    testFile: "apps/server/src/shell/_shared/anonymous-source-identifier.test.ts",
    testName: "keeps the source admission HMAC key out of identifiers and failures",
  },
  {
    configuration: "FIDY_CLUSTER_AUTH_TOKEN",
    testFile: "apps/server/src/shell/authenticated-cluster-http.test.ts",
    testName: "keeps Cluster credentials out of authentication failures",
  },
  {
    configuration: "RESEND_API_KEY",
    testFile: "apps/server/src/shell/email-authentication/delivery.test.ts",
    testName: "keeps Resend credentials out of typed failures",
  },
  {
    configuration: "RESEND_WEBHOOK_SECRET",
    testFile: "apps/server/src/shell/ingestion/email-forwarding.test.ts",
    testName: "enables one permanent address and securely admits durable authenticated work",
  },
  {
    configuration: "KAPSO_API_KEY",
    testFile: "apps/server/src/shell/channels/whatsapp/kapso-client.test.ts",
    testName: "keeps provider bodies and send inputs out of typed failures",
  },
  {
    configuration: "KAPSO_WEBHOOK_SECRET",
    testFile: "apps/server/src/shell/channels/whatsapp/kapso-webhook.test.ts",
    testName: "rejects lifecycle proof that does not identify one valid latest event",
  },
  {
    configuration: "WOMPI_PRIVATE_KEY",
    testFile: "apps/server/src/shell/subscription/wompi-client.test.ts",
    testName: "keeps provider credentials, card tokens, and response bodies out of failures",
  },
  {
    configuration: "WOMPI_INTEGRITY_SECRET",
    testFile: "apps/server/src/shell/subscription/wompi-billing-client.test.ts",
    testName: "keeps Wompi integrity credentials and response bodies out of failures",
  },
  {
    configuration: "WOMPI_EVENT_SECRET",
    testFile: "apps/server/src/shell/subscription/enrollment-handlers.test.ts",
    testName: "keeps Wompi event secrets out of authentication failures",
  },
  {
    configuration: "WOMPI_RECONCILIATION_SOURCE_ID",
    testFile: "apps/server/src/shell/subscription/wompi-client.test.ts",
    testName: "keeps reconciliation source IDs out of lookup failures",
  },
  {
    configuration: "WOMPI_SANDBOX_CARD_TOKEN",
    testFile: "apps/server/src/shell/subscription/wompi-client.test.ts",
    testName: "keeps provider credentials, card tokens, and response bodies out of failures",
  },
  {
    configuration: "DATABASE_URL",
    testFile: "apps/server/src/shell/db/row-level-security.test.ts",
    testName: "starts only with a restricted runtime role and complete forced policy coverage",
  },
  {
    configuration: "MIGRATION_DATABASE_URL",
    testFile: "apps/server/src/shell/db/row-level-security.test.ts",
    testName: "fails closed when the runtime connection uses the migration authority",
  },
  {
    configuration: "SENTRY_PRODUCTION_DSN",
    testFile: "apps/server/src/shell/observability/telemetry-config.test.ts",
    testName: "keeps enabled capture closed while deployment project identities are unprovisioned",
  },
  {
    configuration: "SENTRY_NON_PRODUCTION_DSN",
    testFile: "apps/server/src/shell/observability/telemetry-config.test.ts",
    testName: "validates a full-capture non-production account smoke identity",
  },
  {
    configuration: "SENTRY_AUTH_TOKEN",
    testFile: "apps/server/src/shell/observability/sentry-account-reader.test.ts",
    testName: "loads all operator Sentry account credentials as redacted values",
  },
  {
    configuration: "SENTRY_ORGANIZATION_SLUG",
    testFile: "apps/server/src/shell/observability/sentry-account-reader.test.ts",
    testName: "loads all operator Sentry account credentials as redacted values",
  },
  {
    configuration: "SENTRY_PRODUCTION_PROJECT_SLUG",
    testFile: "apps/server/src/shell/observability/sentry-account-reader.test.ts",
    testName: "loads all operator Sentry account credentials as redacted values",
  },
  {
    configuration: "SENTRY_NON_PRODUCTION_PROJECT_SLUG",
    testFile: "apps/server/src/shell/observability/sentry-account-reader.test.ts",
    testName: "loads all operator Sentry account credentials as redacted values",
  },
] as const satisfies ReadonlyArray<CredentialEvidence>;

type ConditionalWrapper = Readonly<{
  method: "skipIf" | "runIf";
  condition: Option.Option<Babel.Node>;
}>;

const calleeSegments = (node: Babel.Node): ReadonlyArray<string> => {
  if (Babel.isIdentifier(node)) return [node.name];
  if (Babel.isMemberExpression(node) && !node.computed && Babel.isIdentifier(node.property)) {
    return [...calleeSegments(node.object), node.property.name];
  }
  return [];
};

const conditionalWrapper = (node: Babel.CallExpression): Option.Option<ConditionalWrapper> => {
  const directSegments = calleeSegments(node.callee);
  const directMethod = directSegments[directSegments.length - 1];
  if (directMethod === "skipIf" || directMethod === "runIf") {
    return Option.some({
      method: directMethod,
      condition: Option.fromUndefinedOr(node.arguments[0]),
    });
  }

  if (!Babel.isCallExpression(node.callee)) return Option.none();
  const wrappedSegments = calleeSegments(node.callee.callee);
  const wrappedMethod = wrappedSegments[wrappedSegments.length - 1];
  if (wrappedMethod !== "skipIf" && wrappedMethod !== "runIf") return Option.none();
  return Option.some({
    method: wrappedMethod,
    condition: Option.fromUndefinedOr(node.callee.arguments[0]),
  });
};

const staticBoolean = (node: Option.Option<Babel.Node>): Option.Option<boolean> => {
  if (Option.isNone(node)) return Option.none();
  if (Babel.isBooleanLiteral(node.value)) return Option.some(node.value.value);
  if (Babel.isTSAsExpression(node.value) || Babel.isTSTypeAssertion(node.value)) {
    return staticBoolean(Option.some(node.value.expression));
  }
  if (Babel.isUnaryExpression(node.value) && node.value.operator === "!") {
    const value = staticBoolean(Option.some(node.value.argument));
    return Option.map(value, (booleanValue) => !booleanValue);
  }
  if (Babel.isLogicalExpression(node.value)) {
    return staticLogicalBoolean(node.value);
  }
  return Option.none();
};

const staticLogicalBoolean = (node: Babel.LogicalExpression): Option.Option<boolean> => {
  const left = staticBoolean(Option.some(node.left));
  const right = staticBoolean(Option.some(node.right));
  if (Option.isNone(left) || Option.isNone(right)) return Option.none();
  if (node.operator === "&&") return Option.some(left.value && right.value);
  if (node.operator === "||") return Option.some(left.value || right.value);
  return Option.none();
};

const isStaticallySkipped = (wrapper: ConditionalWrapper): boolean => {
  const condition = staticBoolean(wrapper.condition);
  if (Option.isNone(condition)) return false;
  return wrapper.method === "skipIf" ? condition.value : !condition.value;
};

const testDeclarationSegments = (node: Babel.CallExpression): ReadonlyArray<string> => {
  const directSegments = calleeSegments(node.callee);
  if (directSegments[0] === "it" || directSegments[0] === "test") return directSegments;
  if (!Babel.isCallExpression(node.callee)) return [];
  const wrappedSegments = calleeSegments(node.callee.callee);
  return wrappedSegments[0] === "it" || wrappedSegments[0] === "test" ? wrappedSegments : [];
};

const isSkippedTestDeclaration = (node: Babel.CallExpression): boolean => {
  const segments = testDeclarationSegments(node);
  if (segments.length === 0) return false;
  if (segments.includes("skip") || segments.includes("todo")) return true;
  const wrapper = conditionalWrapper(node);
  return Option.isSome(wrapper) && isStaticallySkipped(wrapper.value);
};

const isSkippedSuite = (node: Babel.CallExpression): boolean => {
  const segments = calleeSegments(node.callee);
  if (segments.includes("skip") || segments.includes("todo")) return true;
  const wrapper = conditionalWrapper(node);
  return Option.isSome(wrapper) && isStaticallySkipped(wrapper.value);
};

const isMatchingActiveDeclaration = (node: Babel.CallExpression, testName: string): boolean => {
  const firstArgument = node.arguments[0];
  return (
    testDeclarationSegments(node).length > 0 &&
    !isSkippedTestDeclaration(node) &&
    Babel.isStringLiteral(firstArgument) &&
    firstArgument.value === testName
  );
};

const countActiveTestDeclarations = (source: string, testName: string): number => {
  const syntax = parse(source, { sourceType: "module", plugins: ["typescript"] });
  let declarations = 0;
  traverse(syntax, {
    CallExpression: (path) => {
      if (!isMatchingActiveDeclaration(path.node, testName)) return;
      const skippedSuite = path.findParent(
        (parent) => parent.isCallExpression() && isSkippedSuite(parent.node)
      );
      if (skippedSuite === null) declarations += 1;
    },
  });
  return declarations;
};

const runStaticSkipRegression = (): void => {
  const source = `
    describe.skipIf(true)("skipped suite", () => {
      it("describe.skipIf(true)", () => {});
    });
    describe.runIf(false)("skipped suite", () => {
      test("describe.runIf(false)", () => {});
    });
    it.skip("it.skip", () => {});
    it.todo("it.todo");
    test.skip("test.skip", () => {});
    it.skipIf(true)("it.skipIf(true)", () => {});
    test.runIf(false)("test.runIf(false)", () => {});
    describe.skipIf(false)("active suite", () => {
      it("active skipIf", () => {});
    });
    describe.runIf(true)("active suite", () => {
      test("active runIf", () => {});
    });
    it("active it", () => {});
    test("active test", () => {});
    it("duplicate active", () => {});
    it("duplicate active", () => {});
  `;
  const expected: ReadonlyArray<readonly [string, number]> = [
    ["describe.skipIf(true)", 0],
    ["describe.runIf(false)", 0],
    ["it.skip", 0],
    ["it.todo", 0],
    ["test.skip", 0],
    ["it.skipIf(true)", 0],
    ["test.runIf(false)", 0],
    ["active skipIf", 1],
    ["active runIf", 1],
    ["active it", 1],
    ["active test", 1],
    ["duplicate active", 2],
  ];
  for (const [testName, expectedCount] of expected) {
    const actualCount = countActiveTestDeclarations(source, testName);
    if (actualCount !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} active declarations for ${JSON.stringify(testName)}, got ${actualCount}`
      );
    }
  }
  process.stdout.write("Credential evidence static-skip regression passed.\n");
};

const expectConfiguredSecretNames = (source: string, expected: ReadonlyArray<string>): void => {
  const actual = configuredSecretNames(source);
  if (actual.join(",") !== expected.join(",")) {
    throw new Error(
      `Expected configuredSecret enumeration ${expected.join(",")}, got ${actual.join(",")}`
    );
  }
};

const expectConfiguredSecretRejection = (source: string, label: string): void => {
  let rejected = false;
  try {
    configuredSecretNames(source);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Expected ${label} to be rejected`);
};

const loaderImport = (loader: CredentialLoader): string =>
  `import { ${loader.call} } from "~/${loader.moduleSuffix}";`;

const loaderAliasImport = (loader: CredentialLoader, local: string): string =>
  `import { ${loader.call} as ${local} } from "~/${loader.moduleSuffix}";`;

const loaderNamespaceImport = (loader: CredentialLoader): string =>
  `import * as credentials from "~/${loader.moduleSuffix}";`;

const loaderDeclaration = (loader: CredentialLoader, value: string): string =>
  `{ ${loader.nameProperty}: "${value}", other: true }`;

const runCredentialLoaderEnumerationRegression = (): void => {
  for (const loader of credentialLoaders) {
    expectConfiguredSecretNames(
      `
        ${loaderImport(loader)}
        ${loader.call}(${loaderDeclaration(loader, "FIRST_SECRET")});
        ${loader.call}({ other: true, ${loader.nameProperty}: "REORDERED_SECRET" });
        ${loader.call}({ other: true, ${loader.nameProperty}: "TRAILING_SECRET", tail: 1 });
        ${loader.call}(${loaderDeclaration(loader, "CONST_SECRET")} as const);
      `,
      ["FIRST_SECRET", "REORDERED_SECRET", "TRAILING_SECRET", "CONST_SECRET"]
    );
    expectConfiguredSecretNames(
      `
        ${loaderAliasImport(loader, "readCredential")}
        readCredential(${loaderDeclaration(loader, "ALIASED_SECRET")});
      `,
      ["ALIASED_SECRET"]
    );
    expectConfiguredSecretNames(
      `
        ${loaderNamespaceImport(loader)}
        credentials.${loader.call}(${loaderDeclaration(loader, "NAMESPACED_SECRET")});
      `,
      ["NAMESPACED_SECRET"]
    );
  }
  process.stdout.write("Credential evidence loader enumeration regression passed.\n");
};

const loaderRejections = (loader: CredentialLoader): ReadonlyArray<readonly [string, string]> => [
  [
    `${loader.call}({ other: true, ${loader.nameProperty}: dynamicName });`,
    `a non-literal ${loader.call} ${loader.nameProperty}`,
  ],
  [
    `${loader.call}({ ...base, ${loader.nameProperty}: "SPREAD_SECRET" });`,
    `a spread ${loader.call} declaration`,
  ],
  [
    `${loader.call}({ ["${loader.nameProperty}"]: "COMPUTED_SECRET", other: true });`,
    `a computed ${loader.call} ${loader.nameProperty}`,
  ],
  [
    `${loader.call}({ other: true });`,
    `a ${loader.call} declaration without a ${loader.nameProperty}`,
  ],
  [`${loader.call}(declaration);`, `a non-literal ${loader.call} declaration`],
  [`const readCredential = ${loader.call};`, `an aliased ${loader.call} binding`],
  [
    `${loader.call}?.(${loaderDeclaration(loader, "OPTIONAL_SECRET")});`,
    `an optional ${loader.call} call`,
  ],
  [
    `(0, ${loader.call})(${loaderDeclaration(loader, "SEQUENCE_SECRET")});`,
    `a sequenced ${loader.call} call`,
  ],
  [
    `${loader.call}.call(null, ${loaderDeclaration(loader, "CALL_SECRET")});`,
    `a ${loader.call} .call invocation`,
  ],
];

const runCredentialLoaderRejectionRegression = (): void => {
  for (const loader of credentialLoaders) {
    for (const [statement, label] of loaderRejections(loader)) {
      expectConfiguredSecretRejection(
        `
          ${loaderImport(loader)}
          ${statement}
        `,
        label
      );
    }
    expectConfiguredSecretRejection(
      `
        import { ${loader.call} } from "~/shell/_shared/secret-barrel";
        ${loader.call}(${loaderDeclaration(loader, "BARREL_SECRET")});
      `,
      `a ${loader.call} imported through a barrel`
    );
  }
  process.stdout.write("Credential evidence loader rejection regression passed.\n");
};

const propertyKeyName = (property: Babel.ObjectProperty): Option.Option<string> => {
  if (property.computed) return Option.none();
  if (Babel.isIdentifier(property.key)) return Option.some(property.key.name);
  if (Babel.isStringLiteral(property.key)) return Option.some(property.key.value);
  return Option.none();
};

/** One loader whose call sites name a configured credential literally enough to enumerate. */
type CredentialLoader = Readonly<{
  readonly call: string;
  readonly moduleSuffix: string;
  readonly nameProperty: string;
}>;

const credentialLoaders = [
  { call: "configuredSecret", moduleSuffix: "configured-secret", nameProperty: "name" },
  { call: "configuredHmacKey", moduleSuffix: "hmac", nameProperty: "variable" },
] as const satisfies ReadonlyArray<CredentialLoader>;

const credentialLoaderCalls: ReadonlySet<string> = new Set(
  credentialLoaders.map((loader) => loader.call)
);

/** The loaders' local import bindings, so an aliased import cannot hide a configured Secret. */
type CredentialLoaderBindings = Readonly<{
  readonly names: ReadonlyMap<string, CredentialLoader>;
  readonly namespaces: ReadonlyMap<string, CredentialLoader>;
}>;

/** The binding maps while an import declaration is recorded, before they become read-only. */
type MutableCredentialLoaderBindings = Readonly<{
  readonly names: Map<string, CredentialLoader>;
  readonly namespaces: Map<string, CredentialLoader>;
}>;

/** Records the local import bindings of a loader, so an aliased import cannot hide a Secret. */
const recordCredentialImport = (
  specifier: Babel.ImportDeclaration["specifiers"][number],
  loader: CredentialLoader,
  bindings: MutableCredentialLoaderBindings
): void => {
  if (Babel.isImportSpecifier(specifier)) {
    const imported = Babel.isIdentifier(specifier.imported)
      ? specifier.imported.name
      : specifier.imported.value;
    if (imported === loader.call) bindings.names.set(specifier.local.name, loader);
    return;
  }
  if (Babel.isImportNamespaceSpecifier(specifier)) {
    bindings.namespaces.set(specifier.local.name, loader);
  }
};

const credentialLoaderBindings = (syntax: Babel.File): CredentialLoaderBindings => {
  const bindings: MutableCredentialLoaderBindings = { names: new Map(), namespaces: new Map() };
  for (const node of syntax.program.body) {
    if (!Babel.isImportDeclaration(node)) continue;
    for (const loader of credentialLoaders) {
      if (!node.source.value.endsWith(loader.moduleSuffix)) continue;
      for (const specifier of node.specifiers) {
        recordCredentialImport(specifier, loader, bindings);
      }
    }
  }
  return bindings;
};

const loaderForCallee = (
  callee: Babel.Node,
  bindings: CredentialLoaderBindings
): Option.Option<CredentialLoader> => {
  const segments = calleeSegments(callee);
  const [head, tail] = segments;
  if (head === undefined) return Option.none();
  if (segments.length === 1) return Option.fromUndefinedOr(bindings.names.get(head));
  if (segments.length !== 2 || tail === undefined) return Option.none();
  const loader = bindings.namespaces.get(head);
  if (loader === undefined) return Option.none();
  return loader.call === tail ? Option.some(loader) : Option.none();
};

/** Unwraps the literal argument wrappers the gate can see through (`as const`, parentheses). */
const configurationObject = (
  node: Option.Option<Babel.Node>
): Option.Option<Babel.ObjectExpression> => {
  if (Option.isNone(node)) return Option.none();
  if (Babel.isObjectExpression(node.value)) return Option.some(node.value);
  if (
    Babel.isTSAsExpression(node.value) ||
    Babel.isTSSatisfiesExpression(node.value) ||
    Babel.isParenthesizedExpression(node.value)
  ) {
    return configurationObject(Option.some(node.value.expression));
  }
  return Option.none();
};

const configurationObjectNames = (
  declaration: Babel.ObjectExpression,
  loader: CredentialLoader
): ReadonlyArray<string> => {
  const names: Array<string> = [];
  for (const property of declaration.properties) {
    if (!Babel.isObjectProperty(property)) {
      throw new Error(
        `${loader.call} must list its configuration properties literally so the credential-evidence gate can enumerate it`
      );
    }
    const keyName = propertyKeyName(property);
    if (Option.isNone(keyName)) {
      throw new Error(
        `${loader.call} must not compute its configuration keys so the credential-evidence gate can enumerate it`
      );
    }
    if (keyName.value !== loader.nameProperty) continue;
    if (!Babel.isStringLiteral(property.value)) {
      throw new Error(
        `${loader.call} must name its configuration with a string literal so the credential-evidence gate can enumerate it`
      );
    }
    names.push(property.value.value);
  }
  if (names.length === 0) {
    throw new Error(
      `${loader.call} must declare a literal ${loader.nameProperty} so the credential-evidence gate can enumerate it`
    );
  }
  return names;
};

const configuredSecretNamesFromCall = (
  node: Babel.CallExpression,
  bindings: CredentialLoaderBindings
): ReadonlyArray<string> => {
  const loader = loaderForCallee(node.callee, bindings);
  if (Option.isNone(loader)) return [];
  const declaration = configurationObject(Option.fromUndefinedOr(node.arguments[0]));
  if (Option.isNone(declaration)) {
    throw new Error(
      `${loader.value.call} must receive an object literal so the credential-evidence gate can enumerate it`
    );
  }
  return configurationObjectNames(declaration.value, loader.value);
};

/** True when the identifier is a local binding imported from one of the loader modules. */
const isLoaderImport = (path: NodePath<Babel.Identifier>): boolean => {
  const specifier = path.parentPath;
  const declaration = specifier.parentPath;
  if (!declaration.isImportDeclaration()) return false;
  const source = declaration.node.source.value;
  if (!credentialLoaders.some((loader) => source.endsWith(loader.moduleSuffix))) return false;
  return (
    specifier.isImportSpecifier() ||
    specifier.isImportNamespaceSpecifier() ||
    specifier.isImportDefaultSpecifier()
  );
};

/** A declaration site names the binding; only its uses must satisfy the call-shape rules. */
const isBindingDeclaration = (path: NodePath<Babel.Identifier>): boolean => {
  const declarator = path.parentPath;
  return declarator.isVariableDeclarator() && declarator.node.id === path.node;
};

const isDirectCallCallee = (path: NodePath<Babel.Identifier>): boolean => {
  const call = path.parentPath;
  return call.isCallExpression() && call.node.callee === path.node;
};

const isLoaderMember = (member: Babel.MemberExpression, call: string): boolean => {
  if (member.computed) return false;
  if (!Babel.isIdentifier(member.property)) return false;
  return member.property.name === call;
};

/** The `x.loader(…)` member call a namespace import is allowed to use. */
const loaderMemberCall = (
  path: NodePath<Babel.Identifier>,
  call: string
): Option.Option<Babel.MemberExpression> => {
  const member = path.parentPath;
  if (!member.isMemberExpression()) return Option.none();
  if (!isLoaderMember(member.node, call)) return Option.none();
  const callPath = member.parentPath;
  if (!callPath.isCallExpression()) return Option.none();
  if (callPath.node.callee !== member.node) return Option.none();
  return Option.some(member.node);
};

const isNamespacedCallObject = (
  path: NodePath<Babel.Identifier>,
  bindings: CredentialLoaderBindings
): boolean => {
  const loader = bindings.namespaces.get(path.node.name);
  if (loader === undefined) return false;
  return Option.match(loaderMemberCall(path, loader.call), {
    onNone: () => false,
    onSome: (member) => member.object === path.node,
  });
};

const isNamespacedCallProperty = (
  path: NodePath<Babel.Identifier>,
  bindings: CredentialLoaderBindings
): boolean =>
  Option.match(loaderMemberCall(path, path.node.name), {
    onNone: () => false,
    onSome: (member) => {
      if (!Babel.isIdentifier(member.object)) return false;
      return bindings.namespaces.get(member.object.name)?.call === path.node.name;
    },
  });

const isAllowedCredentialLoaderUse = (
  path: NodePath<Babel.Identifier>,
  bindings: CredentialLoaderBindings
): boolean => {
  if (isLoaderImport(path)) return true;
  if (isBindingDeclaration(path)) return true;
  if (bindings.names.has(path.node.name)) return isDirectCallCallee(path);
  if (bindings.namespaces.has(path.node.name)) return isNamespacedCallObject(path, bindings);
  return isNamespacedCallProperty(path, bindings);
};

/**
 * Fails closed on every other use of a loader binding: only a direct call (or a namespaced call of
 * a namespace import) can be enumerated, so aliasing, `.call`, optional calls, and barrel imports
 * are rejected instead of silently skipping their credential.
 */
const assertCredentialLoaderUse = (
  path: NodePath<Babel.Identifier>,
  bindings: CredentialLoaderBindings
): void => {
  const name = path.node.name;
  if (
    !credentialLoaderCalls.has(name) &&
    !bindings.names.has(name) &&
    !bindings.namespaces.has(name)
  ) {
    return;
  }
  if (isAllowedCredentialLoaderUse(path, bindings)) return;
  throw new Error(
    `${name} must be called directly, or through a namespace import, so the credential-evidence gate can enumerate it`
  );
};

const configuredSecretNames = (source: string): ReadonlyArray<string> => {
  const direct = Array.from(
    source.matchAll(/Config\.redacted\("([A-Z0-9_]+)"\)/gu),
    ([, name]) => name
  );
  const syntax = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const bindings = credentialLoaderBindings(syntax);
  const configured: Array<string> = [];
  traverse(syntax, {
    CallExpression: (path) => {
      configured.push(...configuredSecretNamesFromCall(path.node, bindings));
    },
    Identifier: (path) => {
      assertCredentialLoaderUse(path, bindings);
    },
  });
  return [...direct, ...configured].filter((name): name is string => name !== undefined);
};

const readConfiguredSecrets = Effect.fn("CredentialEvidenceGate.readConfiguredSecrets")(
  function* () {
    const configured = new Set<string>();
    const sourceGlobs = ["apps/server/src/**/*.ts", "apps/server/scripts/**/*.ts"];
    for (const pattern of sourceGlobs) {
      const sources = new Bun.Glob(pattern);
      for (const path of sources.scanSync({ cwd: "." })) {
        if (path.endsWith(".test.ts")) continue;
        const source = yield* Effect.tryPromise(() => Bun.file(path).text()).pipe(Effect.orDie);
        for (const name of configuredSecretNames(source)) configured.add(name);
      }
    }
    return configured;
  }
);

/** Problems, not exceptions: the run reports every unproven credential at once rather than the first. */
const testProblems = Effect.fn("CredentialEvidenceGate.testProblems")(function* (
  credential: CredentialEvidence
) {
  const file = Bun.file(credential.testFile);
  if (!(yield* Effect.tryPromise(() => file.exists()))) {
    return [`${credential.configuration} references missing ${credential.testFile}`];
  }
  const source = yield* Effect.tryPromise(() => file.text());
  const declarations = countActiveTestDeclarations(source, credential.testName);
  return declarations === 1
    ? []
    : [
        `${credential.configuration} references ${declarations} concrete non-skipped declarations ` +
          `for "${credential.testName}" in ${credential.testFile}; expected exactly one`,
      ];
}, Effect.orDie);

const mappingProblems = (configured: ReadonlySet<string>): ReadonlyArray<string> => [
  ...[...configured].flatMap((configuration) => {
    const count = credentialEvidence.filter(
      (entry) => entry.configuration === configuration
    ).length;
    return count === 1
      ? []
      : [`${configuration} has ${count} credential mappings; expected exactly one`];
  }),
  ...credentialEvidence.flatMap((credential) =>
    configured.has(credential.configuration)
      ? []
      : [`${credential.configuration} is no longer an implemented redacted credential`]
  ),
];

const program = Effect.gen(function* () {
  const configured = yield* readConfiguredSecrets();
  const problems = [
    ...mappingProblems(configured),
    ...(yield* Effect.forEach(credentialEvidence, testProblems)).flat(),
  ];
  if (problems.length > 0) {
    process.stderr.write(
      `Credential evidence gate failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`
    );
    process.exit(1);
  }
  process.stdout.write(
    `Credential evidence gate passed: ${credentialEvidence.length} credential paths.\n`
  );
});

if (import.meta.main) {
  if (Bun.argv.includes("--self-test")) {
    runStaticSkipRegression();
    runCredentialLoaderEnumerationRegression();
    runCredentialLoaderRejectionRegression();
  } else {
    await Effect.runPromise(program);
  }
}
