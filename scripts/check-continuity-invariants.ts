#!/usr/bin/env bun

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as Babel from "@babel/types";
import { Effect, Option } from "effect";

const matrixPath = "docs/architecture/agent-continuity-invariant-matrix.md";

type TestEvidence = Readonly<{
  testFile: string;
  testNames: ReadonlyArray<string>;
}>;

type InvariantEvidence = TestEvidence & Readonly<{ id: string }>;
type ExtendedInvariantEvidence = InvariantEvidence &
  Readonly<{ additionalTests: ReadonlyArray<TestEvidence> }>;

const evidence = [
  {
    id: "HI-01",
    testFile: "apps/server/src/shell/agent/hosted-inference.test.ts",
    testNames: ["executes only the immutable complete request stored by preparation"],
  },
  {
    id: "HI-02",
    testFile: "apps/server/src/shell/agent/hosted-inference.test.ts",
    testNames: ["rejects a request that fits before complete tools, framing, and output reserve"],
  },
  {
    id: "HI-03",
    testFile: "apps/server/src/shell/agent/openai.test.ts",
    testNames: [
      "refuses startup when the maximum continuity request exceeds model capacity",
      "frames every independent continuity maximum in startup's complete request",
    ],
  },
  {
    id: "HI-04",
    testFile: "apps/server/src/shell/agent/hosted-inference.test.ts",
    testNames: [
      "keeps orchestration free of model and tokenizer dependencies",
      "exposes only provider-neutral preparation data to the HostedInference adapter",
    ],
  },
  {
    id: "HI-05",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["keeps exact Transcript when generated replacement exceeds its token bound"],
  },
  {
    id: "WC-01",
    testFile: "apps/server/src/shell/agent/hosted-inference.test.ts",
    testNames: ["projects every section in the canonical semantic order"],
  },
  {
    id: "WC-02",
    testFile: "apps/server/src/shell/agent/agent-service.test.ts",
    testNames: ["blocks an injected persisted instruction from authorizing a mutation"],
  },
  {
    id: "WC-03",
    testFile: "apps/server/src/shell/agent/openai.test.ts",
    testNames: ["accumulates provider output and canonical outcomes across three rounds"],
  },
  {
    id: "WC-04",
    testFile: "apps/server/src/shell/agent/agent-service.test.ts",
    testNames: [
      "does not append the active User entry when complete hosted preparation exceeds capacity",
    ],
  },
  {
    id: "WC-05",
    testFile: "apps/server/src/shell/agent/working-context.test.ts",
    testNames: ["projects the same immutable prepared context more than once"],
    additionalTests: [
      {
        testFile: "apps/server/src/shell/agent/hosted-inference.test.ts",
        testNames: ["executes only the immutable complete request stored by preparation"],
      },
    ],
  },
  {
    id: "WC-06",
    testFile: "apps/server/src/shell/agent/openai.test.ts",
    testNames: [
      "refuses an active request above its independent token capacity before provider I/O",
      "frames every independent continuity maximum in startup's complete request",
      "varies each continuity budget without changing the other four semantic sections",
    ],
    additionalTests: [
      {
        testFile: "apps/server/src/core/memory/rules.test.ts",
        testNames: [
          "admits an aggregate at the token cap",
          "rejects an aggregate above the token cap without content-bearing failure fields",
        ],
      },
      {
        testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
        testNames: [
          "triggers from a few large-token turns independently of retained bytes",
          "keeps exact Transcript when generated replacement exceeds its token bound",
        ],
      },
      {
        testFile: "apps/server/src/shell/agent/hosted-inference.test.ts",
        testNames: [
          "rejects a request that fits before complete tools, framing, and output reserve",
        ],
      },
    ],
  },
  {
    id: "CT-01",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["persists explicit Pending Completed Failed and Interrupted Turn states"],
  },
  {
    id: "CT-02",
    testFile: "apps/server/src/shell/agent/agent-service.test.ts",
    testNames: [
      "fails non-retryable provider errors after one attempt",
      "marks a hosted Turn failed when delivery rejects the generated reply",
    ],
  },
  {
    id: "CT-03",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["recovers an abandoned Pending Turn exactly once as Interrupted"],
  },
  {
    id: "CT-04",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["persists fixed failure evidence outside model input"],
  },
  {
    id: "CT-05",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["returns ContinuityChanged without appending a stale active request"],
  },
  {
    id: "CT-06",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["round-trips maximum multibyte text and every maximum tool outcome exactly"],
  },
  {
    id: "CT-07",
    testFile: "apps/server/src/shell/agent/agent-service.test.ts",
    testNames: ["persists complete text turns for the next service instance"],
  },
  {
    id: "CT-08",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["isolates preparation recovery observation and terminalization by User"],
  },
  {
    id: "CT-09",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["serializes the same User across fresh module instances"],
  },
  {
    id: "CT-10",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["prevents a superseded attempt from admitting after asynchronous preparation"],
  },
  {
    id: "DL-01",
    testFile: "apps/server/src/shell/channels/whatsapp/whatsapp-channel.test.ts",
    testNames: [
      "completes delivery when consent is revoked before recording and processes the next turn",
    ],
  },
  {
    id: "DL-02",
    testFile: "apps/server/src/shell/channels/whatsapp/whatsapp-channel.test.ts",
    testNames: ["retries delivery without replaying the real hosted Turn or canonical mutation"],
  },
  {
    id: "DL-03",
    testFile: "apps/server/src/shell/agent/agent-service.test.ts",
    testNames: ["leaves interrupted delivery Pending for the next serialized preparation"],
  },
  {
    id: "CP-01",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: [
      "does not trigger from many messages or retained bytes without enough tokens",
      "triggers from a few large-token turns independently of retained bytes",
      "keeps the decision equal for equal tokens with different byte volume",
    ],
  },
  {
    id: "CP-02",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["compacts complete turns at the token threshold and retains Turn metadata"],
  },
  {
    id: "CP-03",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["feeds prior state and only post-cursor exact entries into a second compaction"],
  },
  {
    id: "CP-04",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["leaves Consent unlocked while generation is blocked"],
  },
  {
    id: "CP-05",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["rolls back replacement when persistence fails before exact-prefix deletion"],
  },
  {
    id: "CP-06",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: [
      "deletes nothing across failed malformed and oversized Compaction",
      "deletes nothing across Consent revoke and re-grant ABA during generation",
      "deletes nothing when continuity revision changes after generation",
      "reloads exact continuity and deletes nothing when Memory changes after generation",
      "rolls back replacement when persistence fails before exact-prefix deletion",
    ],
    additionalTests: [
      {
        testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
        testNames: ["times out inference without deleting exact Transcript"],
      },
    ],
  },
  {
    id: "CP-07",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["CP-07 keeps concurrent Compaction generations from committing out of order"],
  },
  {
    id: "CP-08",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["CP-08 retries Compaction without losing exact Transcript after inference failure"],
    additionalTests: [
      {
        testFile: "apps/server/src/shell/agent/openai.test.ts",
        testNames: ["rejects complete-capacity overflow before execution"],
      },
      {
        testFile: "apps/server/src/shell/agent/agent-service.test.ts",
        testNames: [
          "does not append the active User entry when complete hosted preparation exceeds capacity",
        ],
      },
    ],
  },
  {
    id: "CP-09",
    testFile: "apps/server/src/shell/agent/agent-service.test.ts",
    testNames: ["answers from CompactedConversation after deleting exact source entries"],
  },
  {
    id: "CP-10",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["rewrites the User's sole CompactedConversation"],
  },
  {
    id: "CP-11",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["round-trips schema-generated semantic content through PostgreSQL exactly"],
  },
  {
    id: "MM-01",
    testFile: "apps/server/src/shell/agent/toolkit.test.ts",
    testNames: [
      "derives exact canonical Memory identities across API, client, OpenAPI, hosted, and MCP",
    ],
  },
  {
    id: "MM-02",
    testFile: "apps/server/src/core/memory/model.test.ts",
    testNames: ["normalizes only line endings and outer whitespace in arbitrary Memory prose"],
  },
  {
    id: "MM-03",
    testFile: "apps/server/src/shell/memory/memory-policy.test.ts",
    testNames: [
      "counts the complete recall-ordered aggregate including the final candidate",
      "rejects an aggregate above 15,000 tokens without returning prose",
    ],
  },
  {
    id: "MM-04",
    testFile: "apps/server/src/shell/agent/agent-service.test.ts",
    testNames: ["requires exact single-use confirmation for hosted Memory revision and deletion"],
  },
  {
    id: "MM-05",
    testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
    testNames: ["returns ContinuityChanged when Memory changes after preparation"],
  },
  {
    id: "MM-06",
    testFile: "apps/server/src/shell/testing/authorization.test.ts",
    testNames: ["enforces independent read and write scopes for Memory"],
  },
  {
    id: "MM-07",
    testFile: "apps/server/src/shell/memory/handlers.test.ts",
    testNames: [
      "normalizes, persists, and recalls every current Memory in stable order",
      "revises one Memory in place through the canonical API",
      "physically forgets a Memory and advances every committed mutation revision",
    ],
  },
  {
    id: "MM-08",
    testFile: "apps/server/src/shell/agent/model-boundary.test.ts",
    testNames: [
      "warns against credentials and unnecessary sensitive information without soliciting them",
    ],
  },
  {
    id: "PR-01",
    testFile: "apps/server/src/shell/agent/model-boundary.test.ts",
    testNames: [
      "warns against credentials and unnecessary sensitive information without soliciting them",
    ],
  },
  {
    id: "PR-02",
    testFile: "apps/server/src/shell/observability/envelope-recorder.test.ts",
    testNames: ["records only reconstructed metadata in complete serialized envelopes"],
    additionalTests: [
      {
        testFile: "apps/server/src/shell/audit/audit-log.test.ts",
        testNames: [
          "appends metadata-only evidence for a successful canonical operation",
          "appends successful evidence for a User preference mutation",
          "appends failed evidence when canonical input is rejected",
        ],
      },
      {
        testFile: "apps/server/src/shell/transcript/conversation-continuity.test.ts",
        testNames: ["persists fixed failure evidence outside model input"],
      },
      {
        testFile: "apps/server/src/shell/agent/agent-service.test.ts",
        testNames: [
          "captures only an exhausted provider failure and marks its spans failed",
          "captures an unexpected model defect exactly once at the turn owner",
          "fails non-retryable provider errors after one attempt",
          "times out a stalled model round without retaining the Consent lock",
          "keeps hosted outcome telemetry metadata-only across success, failure, and timeout",
          "marks a hosted Turn failed when delivery rejects the generated reply",
        ],
      },
      {
        testFile: "apps/server/src/shell/channels/whatsapp/whatsapp-channel.test.ts",
        testNames: ["reports a worker defect and runs the next loop iteration"],
      },
    ],
  },
  {
    id: "PR-03",
    testFile: "apps/server/src/shell/agent/agent-service.test.ts",
    testNames: [
      "rejects credentials and payment identifiers before persistence or model invocation",
      "removes bearers returned by canonical reads before model context or Transcript",
    ],
  },
] as const satisfies ReadonlyArray<InvariantEvidence | ExtendedInvariantEvidence>;

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

const fail = (problems: ReadonlyArray<string>): never => {
  process.stderr.write(
    `Continuity invariant gate failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`
  );
  process.exit(1);
};

const problems: Array<string> = [];

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
  process.stdout.write("Continuity invariant static-skip regression passed.\n");
};

const verifyTest = Effect.fn("ContinuityInvariantGate.verifyTest")(function* (
  testFile: string,
  testName: string,
  owner: string
) {
  const file = Bun.file(testFile);
  if (!(yield* Effect.promise(() => file.exists()))) {
    problems.push(`${owner} references missing ${testFile}`);
    return;
  }
  const source = yield* Effect.promise(() => file.text());
  const declarations = countActiveTestDeclarations(source, testName);
  if (declarations !== 1) {
    problems.push(
      `${owner} references ${declarations} concrete non-skipped declarations for ` +
        `"${testName}" in ${testFile}; expected exactly one`
    );
  }
});

const verifyMatrix = Effect.fn("ContinuityInvariantGate.verifyMatrix")(function* () {
  const matrix = yield* Effect.promise(() => Bun.file(matrixPath).text());
  const acceptedIds = Array.from(
    matrix.matchAll(/^\| ((?:HI|WC|CT|DL|CP|MM|PR)-\d{2}) \|/gmu),
    ([, id]) => id
  );
  const evidenceIds = evidence.map(({ id }) => id);
  for (const id of new Set(acceptedIds)) {
    const count = evidenceIds.filter((candidate) => candidate === id).length;
    if (count !== 1) problems.push(`${id} has ${count} evidence mappings; expected exactly one`);
  }
  for (const id of evidenceIds) {
    if (!acceptedIds.includes(id)) problems.push(`${id} is not an accepted matrix row`);
  }
});

const invariantTestEvidence = (
  entry: InvariantEvidence | ExtendedInvariantEvidence
): ReadonlyArray<TestEvidence> => [
  { testFile: entry.testFile, testNames: entry.testNames },
  ...("additionalTests" in entry ? entry.additionalTests : []),
];

const verifyInvariantTests = (): Effect.Effect<void> =>
  Effect.forEach(
    evidence.flatMap((entry) =>
      invariantTestEvidence(entry).flatMap(({ testFile, testNames }) =>
        testNames.map((testName) => ({ id: entry.id, testFile, testName }))
      )
    ),
    ({ id, testFile, testName }) => verifyTest(testFile, testName, id),
    { discard: true }
  );

const configuredSecretNames = (source: string): ReadonlyArray<string> =>
  Array.from(source.matchAll(/Config\.redacted\("([A-Z0-9_]+)"\)/gu), ([, name]) => name).filter(
    (name): name is string => name !== undefined
  );

const readConfiguredSecrets = Effect.fn("ContinuityInvariantGate.readConfiguredSecrets")(
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

const verifyCredentialTests = Effect.fn("ContinuityInvariantGate.verifyCredentialTests")(function* (
  configured: ReadonlySet<string>
) {
  for (const configuration of configured) {
    const count = credentialEvidence.filter(
      (entry) => entry.configuration === configuration
    ).length;
    if (count !== 1) {
      problems.push(`${configuration} has ${count} credential mappings; expected exactly one`);
    }
  }
  for (const credential of credentialEvidence) {
    if (!configured.has(credential.configuration)) {
      problems.push(
        `${credential.configuration} is no longer an implemented Config.redacted credential`
      );
    }
    yield* verifyTest(credential.testFile, credential.testName, credential.configuration);
  }
});

const program = Effect.gen(function* () {
  yield* verifyMatrix();
  yield* verifyInvariantTests();
  yield* verifyCredentialTests(yield* readConfiguredSecrets());
  if (problems.length > 0) fail(problems);
  process.stdout.write(
    `Continuity invariant gate passed: ${evidence.length} rows and ${credentialEvidence.length} credential paths.\n`
  );
});

if (import.meta.main) {
  if (Bun.argv.includes("--self-test")) {
    runStaticSkipRegression();
  } else {
    await Effect.runPromise(program);
  }
}
