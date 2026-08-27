#!/usr/bin/env bun

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as Babel from "@babel/types";
import { Effect, Option } from "effect";

/**
 * Every production `Config.redacted` credential must have one focused test proving its adapter path
 * keeps the secret out of failures, logs, and model context. The pairing is stated here rather than
 * inferred, so adding a credential without that evidence fails the gate instead of shipping unproven.
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
    configuration: "RESEND_API_KEY",
    testFile: "apps/server/src/shell/email-authentication/delivery.test.ts",
    testName: "keeps Resend credentials out of typed failures",
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

const configuredSecretNames = (source: string): ReadonlyArray<string> =>
  Array.from(source.matchAll(/Config\.redacted\("([A-Z0-9_]+)"\)/gu), ([, name]) => name).filter(
    (name): name is string => name !== undefined
  );

const readConfiguredSecrets = Effect.fn("CredentialEvidenceGate.readConfiguredSecrets")(
  function* () {
    const configured = new Set<string>();
    const sourceGlobs = ["apps/server/src/**/*.ts", "apps/server/scripts/**/*.ts"];
    for (const pattern of sourceGlobs) {
      const sources = new Bun.Glob(pattern);
      for (const path of sources.scanSync({ cwd: "." })) {
        if (path.endsWith(".test.ts")) continue;
        const source = yield* Effect.promise(() => Bun.file(path).text());
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
  if (!(yield* Effect.promise(() => file.exists()))) {
    return [`${credential.configuration} references missing ${credential.testFile}`];
  }
  const source = yield* Effect.promise(() => file.text());
  const declarations = countActiveTestDeclarations(source, credential.testName);
  return declarations === 1
    ? []
    : [
        `${credential.configuration} references ${declarations} concrete non-skipped declarations ` +
          `for "${credential.testName}" in ${credential.testFile}; expected exactly one`,
      ];
});

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
      : [`${credential.configuration} is no longer an implemented Config.redacted credential`]
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
  } else {
    await Effect.runPromise(program);
  }
}
