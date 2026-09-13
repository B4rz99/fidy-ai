import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@effect/vitest";
import { Cause, Effect, type Exit, Option, Predicate, Schema, type SchemaAST } from "effect";
import { DurableClock, Workflow } from "effect/unstable/workflow";

/**
 * Test-only executable compatibility contract for persisted Workflow boundaries.
 *
 * Fixtures hold the exact JSON bytes written to SQL by an older deployment. The helpers below
 * decode those bytes with current production schemas, then re-encode them, so any accidental change
 * to a Workflow name, execution identity, Activity identity and primary key, DurableClock or
 * DurableDeferred name, or persisted shape fails the suite. Result schemas are enumerated from their
 * AST, so a new terminal form fails until a fixture pins it. Engine-private payloads (`ActivityRpc`,
 * `DeferredRpc`, `ClockRpc`) and the Activity primary-key composition are mirrored here from public
 * Effect primitives because the engine does not export them; their shapes come from the vendored
 * engine at `.repos/effect/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts`, and the
 * mirrors are re-verified whenever Effect is upgraded.
 */

/**
 * A schema whose decoding and encoding require no services, so JSON assertions can run
 * synchronously without erasing the production declaration to `Schema.Top`.
 */
export type DurableSchema = Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>;

const AnyOrVoid = Schema.Union([Schema.Undefined, Schema.Any]);

/** Mirror of the engine's persisted `DeferredRpc` payload. */
export const PersistedDeferredRequest = Schema.Struct({
  name: Schema.String,
  exit: Schema.Exit(AnyOrVoid, AnyOrVoid, Schema.Any),
}).annotate({ identifier: "PersistedDeferredRequest" });

/** Mirror of the engine's persisted `ResumeRpc` payload. */
export const PersistedResumeRequest = Schema.Struct({}).annotate({
  identifier: "PersistedResumeRequest",
});

/** Mirror of the engine's persisted `ActivityRpc` payload. */
export const PersistedActivityRequest = Schema.Struct({
  name: Schema.String,
  attempt: Schema.Int,
  withTransaction: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
}).annotate({ identifier: "PersistedActivityRequest" });

/** Mirror of the engine's persisted `ClockRpc` payload. */
export const PersistedClockRequest = Schema.Struct({
  name: Schema.String,
  workflowName: Schema.String,
  wakeUp: Schema.DateTimeUtcFromMillis,
}).annotate({ identifier: "PersistedClockRequest" });

const EncodedShapeFixture = Schema.Struct({
  label: Schema.String,
  /** False for any encoding an older version may have left in SQL. */
  current: Schema.Boolean,
  /** The exact persisted bytes written by the producing version. */
  encoded: Schema.Unknown,
  /** Current re-encoding, present only when it intentionally differs from `encoded`. */
  reencoded: Schema.optionalKey(Schema.Unknown),
});
type EncodedShapeFixture = typeof EncodedShapeFixture.Type;

const PersistedResumeFixture = Schema.Struct({
  ...EncodedShapeFixture.fields,
  /** Engine primary key for the one resume message per execution. */
  primaryKey: Schema.String,
});
type PersistedResumeFixture = typeof PersistedResumeFixture.Type;

const WorkflowPayloadFixture = Schema.Struct({
  ...EncodedShapeFixture.fields,
  idempotencyKey: Schema.String,
  executionId: Schema.String,
});
type WorkflowPayloadFixture = typeof WorkflowPayloadFixture.Type;

const PersistedResultFixture = Schema.Struct({
  label: Schema.String,
  kind: Schema.Literals(["success", "error", "suspended", "defect"]),
  /** False for any encoding an older version may have left in SQL. */
  current: Schema.Boolean,
  /** Encoded RPC reply exit exactly as stored in the cluster reply table. */
  persisted: Schema.Unknown,
  /** Current re-encoding, present only when it intentionally differs from `persisted`. */
  reencoded: Schema.optionalKey(Schema.Unknown),
});
type PersistedResultFixture = typeof PersistedResultFixture.Type;

const PersistedActivityFixture = Schema.Struct({
  key: Schema.String,
  /** Engine primary keys: `${name}/${attempt}` for every covered runtime attempt. */
  primaryKeys: Schema.Array(Schema.String),
  requests: Schema.Array(EncodedShapeFixture),
  resultGroup: Schema.String,
});
type PersistedActivityFixture = typeof PersistedActivityFixture.Type;

const PersistedClockFixture = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  deferredName: Schema.String,
  request: Schema.Unknown,
  completion: Schema.Struct({
    name: Schema.String,
    /** False for any encoding an older version may have left in SQL. */
    current: Schema.Boolean,
    /** Encoded `Exit` exactly as stored in the deferred completion request. */
    exit: Schema.Unknown,
    /** Current re-encoding, present only when it intentionally differs from `exit`. */
    reencoded: Schema.optionalKey(Schema.Unknown),
    request: Schema.Unknown,
  }),
});
type PersistedClockFixture = typeof PersistedClockFixture.Type;

const PersistedDeferredFixture = Schema.Struct({
  key: Schema.String,
  /** Persisted deferred name, including the engine's `raceAll/` prefix when applicable. */
  name: Schema.String,
  raceAll: Schema.Boolean,
  /** False for any encoding an older version may have left in SQL. */
  current: Schema.Boolean,
  /** Encoded `Exit` exactly as stored in the deferred completion request. */
  exit: Schema.Unknown,
  /** Current re-encoding, present only when it intentionally differs from `exit`. */
  reencoded: Schema.optionalKey(Schema.Unknown),
  request: Schema.Unknown,
});
type PersistedDeferredFixture = typeof PersistedDeferredFixture.Type;

const PersistedQueueFixture = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  payloads: Schema.Array(
    Schema.Struct({
      ...EncodedShapeFixture.fields,
      /** Persisted queue primary key derived from the payload. */
      id: Schema.String,
    })
  ),
});
type PersistedQueueFixture = typeof PersistedQueueFixture.Type;

/** One checked-in fixture: a Workflow version's persisted bytes, identities, and coverage labels. */
export const DurableWorkflowFixture = Schema.Struct({
  workflow: Schema.Struct({ tag: Schema.String }),
  payloads: Schema.Array(WorkflowPayloadFixture),
  results: Schema.Array(PersistedResultFixture),
  activityResultGroups: Schema.Record(Schema.String, Schema.Array(PersistedResultFixture)),
  activities: Schema.Array(PersistedActivityFixture),
  clocks: Schema.Array(PersistedClockFixture),
  deferreds: Schema.Array(PersistedDeferredFixture),
  queues: Schema.Array(PersistedQueueFixture),
  /** Persisted generic resume message for this Workflow entity. */
  resume: PersistedResumeFixture,
}).annotate({ identifier: "DurableWorkflowFixture" });
export type DurableWorkflowFixture = typeof DurableWorkflowFixture.Type;

/** Checked-in persisted bytes for durable queues that do not start a Workflow. */
export const StandaloneDurableQueueFixture = Schema.Struct({
  queues: Schema.Array(PersistedQueueFixture),
}).annotate({ identifier: "StandaloneDurableQueueFixture" });
export type StandaloneDurableQueueFixture = typeof StandaloneDurableQueueFixture.Type;

/** Activity identity and result schemas declared by production source. */
export type DurableActivitySpec =
  | { readonly name: string; readonly success: DurableSchema; readonly error: DurableSchema }
  | { readonly name: string; readonly success: DurableSchema }
  | { readonly name: string };

/** DurableClock wait identity; every production clock completes its deferred with `Exit.void`. */
export type DurableClockSpec = {
  readonly name: string;
  readonly success: DurableSchema;
  readonly error: DurableSchema;
};

/** DurableDeferred identity and completion schemas, including the engine's `raceAll` form. */
export type DurableDeferredSpec = {
  readonly name: string;
  readonly raceAll: boolean;
  readonly success: DurableSchema;
  readonly error: DurableSchema;
};

/** Queue identity, payload schema, and primary-key derivation. */
export type DurableQueueSpec = {
  readonly key: string;
  readonly name: string;
  readonly schema: DurableSchema;
  readonly queueId: (payload: unknown) => Effect.Effect<string>;
};

/** Complete compatibility contract for one production Workflow. */
export type DurableWorkflowSpec = {
  readonly workflow: Workflow.Any;
  /** The workflow's own schemas, asserted by identity so decoding uses the production declaration. */
  readonly payloadSchema: DurableSchema;
  readonly successSchema: DurableSchema;
  readonly errorSchema: DurableSchema;
  readonly activities: Readonly<Record<string, DurableActivitySpec>>;
  readonly clocks: Readonly<Record<string, DurableClockSpec>>;
  readonly deferreds: Readonly<Record<string, DurableDeferredSpec>>;
  readonly queues: ReadonlyArray<DurableQueueSpec>;
};

/** Declares a DurableClock wait whose completion is `Exit.void`. */
export const durableClockSpec = (name: string): DurableClockSpec => ({
  name,
  success: Schema.Void,
  error: Schema.Never,
});

/** Declares a named `make` DurableDeferred; the engine defaults it to void success, never error. */
export const durableDeferredSpec = (name: string): DurableDeferredSpec => ({
  name,
  raceAll: false,
  success: Schema.Void,
  error: Schema.Never,
});

/** Declares a `raceAll` DurableDeferred whose completion schemas come from its production value. */
export const durableRaceAllDeferredSpec = (input: {
  readonly name: string;
  readonly completion: {
    readonly success: DurableSchema;
    readonly error: DurableSchema;
  };
}): DurableDeferredSpec => ({
  name: input.name,
  raceAll: true,
  success: input.completion.success,
  error: input.completion.error,
});

/** Declares a Workflow-start queue whose primary key comes from its production id helper. */
export const durableQueueSpec = <Payload>(input: {
  readonly key: string;
  readonly name: string;
  readonly schema: DurableSchema & Schema.Schema<Payload>;
  readonly queueId: (payload: Payload) => Effect.Effect<string>;
}): DurableQueueSpec => ({
  key: input.key,
  name: input.name,
  schema: input.schema,
  queueId: (payload) => input.queueId(decodeJsonTyped(input.schema, payload)),
});

const fixturesDirectory = fileURLToPath(new URL("./fixtures/durable-workflows/", import.meta.url));
const standaloneQueuesFixturePath = fileURLToPath(
  new URL("./fixtures/durable-queues.json", import.meta.url)
);
const serverSourceDirectory = fileURLToPath(new URL("../../", import.meta.url));

const parseFixture = (name: string): unknown => {
  const contents: unknown = JSON.parse(readFileSync(`${fixturesDirectory}${name}.json`, "utf8"));
  return contents;
};

/** Loads one checked-in fixture and validates its own shape. */
export const loadDurableWorkflowFixture = (name: string): DurableWorkflowFixture =>
  Schema.decodeUnknownSync(DurableWorkflowFixture)(parseFixture(name));

/** Loads the checked-in persisted forms for queues that do not start a Workflow. */
export const loadStandaloneDurableQueueFixture = (): StandaloneDurableQueueFixture => {
  const contents: unknown = JSON.parse(readFileSync(standaloneQueuesFixturePath, "utf8"));
  return Schema.decodeUnknownSync(StandaloneDurableQueueFixture)(contents);
};

/** Every checked-in workflow fixture name, without the `.json` suffix. */
export const durableWorkflowFixtureNames: ReadonlyArray<string> = [
  ...new Bun.Glob("*.json").scanSync({ cwd: fixturesDirectory }),
]
  .map((entry) => entry.slice(0, -".json".length))
  .sort();

/**
 * Every literal production Workflow tag, preserving duplicates so one fixture cannot conceal a
 * second declaration with the same persisted identity. This intentionally narrow guard leaves
 * Activity, clock, deferred, and queue compatibility to their production-schema fixture specs.
 */
const productionSources = (): ReadonlyArray<{
  readonly file: string;
  readonly source: string;
}> =>
  [...new Bun.Glob("**/*.ts").scanSync({ cwd: serverSourceDirectory })]
    .filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.startsWith("shell/testing/") &&
        !file.startsWith("shell/queue-compatibility/")
    )
    .map((file) => ({ file, source: readFileSync(`${serverSourceDirectory}${file}`, "utf8") }));

export const productionWorkflowTags: ReadonlyArray<string> = (() => {
  const tags: Array<string> = [];
  for (const { file, source } of productionSources()) {
    const calls = [...source.matchAll(/Workflow\.make\b/g)];
    const declarations = [...source.matchAll(/Workflow\.make(?:<[^<>]*>)?\s*\(\s*"([^"]+)"/g)];
    if (calls.length !== declarations.length) {
      throw new Error(`${file}: every Workflow.make must declare a double-quoted literal tag`);
    }
    for (const declaration of declarations) {
      const tag = declaration[1];
      if (tag !== undefined) tags.push(tag);
    }
  }
  return tags.sort();
})();

/** Production deferred completion APIs not represented by the success-only fixtures. */
export const unsupportedDeferredCompletions: ReadonlyArray<string> = productionSources().flatMap(
  ({ file, source }) =>
    [...source.matchAll(/DurableDeferred\.(?:done|fail|failCause)\b/g)].map(
      (match) => `${file}:${match[0]}`
    )
);

const durableCallPatterns = {
  activity: /Activity\.make\b/g,
  clock: /DurableClock\.sleep\b/g,
  deferredAwait: /DurableDeferred\.await\b/g,
  deferredMake: /DurableDeferred\.make\b/g,
  deferredRace: /DurableDeferred\.raceAll\b/g,
  sleepFor: /\bsleepFor\s*\(/g,
  sleepUntil: /\bsleepUntil\s*\(/g,
} as const;

/** Number of durable declaration sites by production file and primitive. */
export const productionDurableCallCounts: Readonly<Record<string, number>> = (() => {
  const counts: Record<string, number> = {};
  for (const { file, source } of productionSources()) {
    for (const [kind, pattern] of Object.entries(durableCallPatterns)) {
      const count = [...source.matchAll(pattern)].length;
      if (count > 0) counts[`${file}:${kind}`] = count;
    }
  }
  return counts;
})();

const decodeJson = (schema: DurableSchema, input: unknown): unknown =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema))(input);

/** Decodes fixture bytes with a schema whose decoded type is known, preserving it in the type. */
const decodeJsonTyped = <Payload>(
  schema: DurableSchema & Schema.Schema<Payload>,
  input: unknown
): Payload => Schema.decodeUnknownSync(Schema.toCodecJson(schema))(input);

const encodeJson = (schema: DurableSchema, value: unknown): unknown =>
  Schema.encodeUnknownSync(Schema.toCodecJson(schema))(value);

// Engine mirrors are concrete schemas; decoding them synchronously keeps assertion generators free
// of erased service requirements.
const decodeActivityRequest = (input: unknown): typeof PersistedActivityRequest.Type =>
  Schema.decodeUnknownSync(PersistedActivityRequest)(input);
const encodeActivityRequest = (input: typeof PersistedActivityRequest.Type): unknown =>
  Schema.encodeUnknownSync(Schema.toCodecJson(PersistedActivityRequest))(input);
const decodeClockRequest = (input: unknown): typeof PersistedClockRequest.Type =>
  Schema.decodeUnknownSync(PersistedClockRequest)(input);
const encodeClockRequest = (input: typeof PersistedClockRequest.Type): unknown =>
  Schema.encodeUnknownSync(Schema.toCodecJson(PersistedClockRequest))(input);
const decodeDeferredRequest = (input: unknown): typeof PersistedDeferredRequest.Type =>
  Schema.decodeUnknownSync(Schema.toCodecJson(PersistedDeferredRequest))(input);
const encodeDeferredRequest = (input: typeof PersistedDeferredRequest.Type): unknown =>
  Schema.encodeUnknownSync(Schema.toCodecJson(PersistedDeferredRequest))(input);

const sameKeys = (
  context: string,
  fixtureKeys: ReadonlyArray<string>,
  specKeys: ReadonlyArray<string>
): void => {
  expect(
    [...fixtureKeys].sort(),
    `${context}: fixture covers exactly the declared identities`
  ).toEqual([...specKeys].sort());
};

const assertEncodedShape = (input: {
  readonly context: string;
  readonly form: EncodedShapeFixture;
  readonly schema: DurableSchema;
}): unknown => {
  const decoded = decodeJson(input.schema, input.form.encoded);
  const reencoded = encodeJson(input.schema, decoded);
  const expected = "reencoded" in input.form ? input.form.reencoded : input.form.encoded;
  expect(reencoded, `${input.context}: re-encoded shape`).toEqual(expected);
  if (input.form.current) {
    expect(expected, `${input.context}: current shape is byte-stable`).toEqual(input.form.encoded);
  }
  return decoded;
};

/**
 * Literal identities a result schema can decode to. Terminal results written by older deployments
 * remain in SQL across a rollout, so every form needs a checked-in fixture; deriving the form set
 * from the production AST, instead of a hand-maintained list, fails closed as soon as a union gains
 * a member. AST shapes come from the vendored engine at
 * `.repos/effect/packages/effect/src/SchemaAST.ts` and are re-verified whenever Effect is upgraded.
 */

/** One literal identity a result schema can decode to. */
type ResultVariant = {
  /** Object property carrying the literal, or none when the value itself is the literal. */
  readonly property: Option.Option<string>;
  readonly value: string;
};

/** Unwraps class-schema declarations and suspensions so literal analysis sees the field AST. */
const unwrapSchemaAst = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (ast._tag === "Declaration") {
    const wrapped = ast.typeParameters[0];
    return wrapped === undefined ? ast : unwrapSchemaAst(wrapped);
  }
  if (ast._tag === "Suspend") {
    return unwrapSchemaAst(ast.thunk());
  }
  return ast;
};

/** The finite literal values an AST can decode to, or none when it is not a finite literal set. */
const literalValues = (ast: SchemaAST.AST): Option.Option<ReadonlyArray<string>> => {
  const node = unwrapSchemaAst(ast);
  if (node._tag === "Literal") {
    return Option.some([String(node.literal)]);
  }
  if (node._tag === "Enum") {
    return Option.some(node.enums.map(([, value]) => String(value)));
  }
  if (node._tag === "Union") {
    return Option.all(node.types.map(literalValues)).pipe(Option.map((groups) => groups.flat()));
  }
  return Option.none();
};

/** The literal property that identifies an object value's variant, when one exists. */
const discriminantOf = (
  node: SchemaAST.Objects
): Option.Option<{ readonly name: string; readonly values: ReadonlyArray<string> }> => {
  const candidates = node.propertySignatures.flatMap((property) => {
    const name = String(property.name);
    const values = literalValues(property.type);
    if (Option.isSome(values)) {
      return [{ name, values: values.value }];
    }
    if (unwrapSchemaAst(property.type)._tag === "Union") {
      throw new Error(
        `result schema property ${name} has a union that is not a finite literal set`
      );
    }
    return [];
  });
  if (candidates.length === 0) {
    return Option.none();
  }
  return Option.some(
    candidates.reduce((best, candidate) =>
      candidate.values.length > best.values.length ? candidate : best
    )
  );
};

/** Literal identities one union member, or a non-union schema, can decode to. */
const memberVariants = (ast: SchemaAST.AST): ReadonlyArray<ResultVariant> => {
  const node = unwrapSchemaAst(ast);
  if (node._tag === "Literal") {
    return [{ property: Option.none(), value: String(node.literal) }];
  }
  if (node._tag === "Enum") {
    return node.enums.map(([, value]) => ({ property: Option.none(), value: String(value) }));
  }
  if (node._tag === "Union") {
    return node.types.flatMap(memberVariants);
  }
  if (node._tag === "Objects") {
    const discriminant = discriminantOf(node);
    if (Option.isNone(discriminant)) {
      return [];
    }
    return discriminant.value.values.map((value) => ({
      property: Option.some(discriminant.value.name),
      value,
    }));
  }
  return [];
};

/** Every literal identity a result schema can decode to; a union member without one fails closed. */
const resultVariants = (context: string, schema: DurableSchema): ReadonlyArray<ResultVariant> => {
  const node = unwrapSchemaAst(schema.ast);
  if (node._tag !== "Union") {
    return memberVariants(node);
  }
  return node.types.flatMap((member) => {
    const variants = memberVariants(member);
    if (variants.length === 0) {
      throw new Error(`${context}: a result schema union member has no literal identity`);
    }
    return variants;
  });
};

/** Whether one decoded result value is the literal identity a variant stands for. */
const matchesResultVariant = (variant: ResultVariant, value: Option.Option<unknown>): boolean => {
  if (Option.isNone(value)) {
    return false;
  }
  if (Option.isNone(variant.property)) {
    return String(value.value) === variant.value;
  }
  const property = variant.property.value;
  return (
    Predicate.isObject(value.value) &&
    Predicate.hasProperty(value.value, property) &&
    String(value.value[property]) === variant.value
  );
};

/** One decoded terminal result together with the production schema that persisted it. */
type DecodedResult = {
  readonly context: string;
  readonly schema: DurableSchema;
  readonly value: Option.Option<unknown>;
};

const assertVariantCoverage = (
  context: string,
  schema: DurableSchema,
  results: ReadonlyArray<DecodedResult>
): void => {
  const variants = resultVariants(context, schema);
  if (variants.length === 0) {
    return;
  }
  const covered = new Set<string>();
  for (const result of results) {
    const matches = variants.filter((variant) => matchesResultVariant(variant, result.value));
    expect(matches.length, `${result.context}: exactly one literal result variant`).toBe(1);
    for (const match of matches) {
      covered.add(match.value);
    }
  }
  for (const variant of variants) {
    expect(covered.has(variant.value), `${context}: variant ${variant.value} has a fixture`).toBe(
      true
    );
  }
};

/** Groups decoded results by the production schema object that persisted them. */
const groupBySchema = (
  results: ReadonlyArray<DecodedResult>
): Map<DurableSchema, Array<DecodedResult>> => {
  const groups = new Map<DurableSchema, Array<DecodedResult>>();
  for (const result of results) {
    const group = groups.get(result.schema);
    if (group === undefined) {
      groups.set(result.schema, [result]);
    } else {
      group.push(result);
    }
  }
  return groups;
};

/** Asserts every literal variant of every result schema is pinned by a checked-in fixture. */
const assertResultVariants = (context: string, results: ReadonlyArray<DecodedResult>): void => {
  for (const [schema, group] of groupBySchema(results)) {
    assertVariantCoverage(
      context,
      schema,
      group.filter((result) => Option.isSome(result.value))
    );
  }
};

/** Every literal value of every record-shaped schema property; none for non-record schemas. */
const recordVariants = (ast: SchemaAST.AST): ReadonlyArray<ResultVariant> => {
  const node = unwrapSchemaAst(ast);
  if (node._tag !== "Objects") {
    return [];
  }
  return node.propertySignatures.flatMap((property) => {
    const values = literalValues(property.type);
    if (Option.isNone(values)) {
      return [];
    }
    return values.value.map((value) => ({
      property: Option.some(String(property.name)),
      value,
    }));
  });
};

const variantKey = (variant: ResultVariant): string =>
  `${Option.isNone(variant.property) ? "" : variant.property.value}\u0000${variant.value}`;

const variantLabel = (variant: ResultVariant): string =>
  Option.isNone(variant.property) ? variant.value : `${variant.property.value}=${variant.value}`;

/**
 * Asserts every literal field value of a record-shaped schema is pinned by a checked-in fixture.
 * Workflow and queue payloads are records rather than discriminated unions, so widening any literal
 * property must ship with the fixture that pins the new form.
 */
const assertRecordVariants = (context: string, results: ReadonlyArray<DecodedResult>): void => {
  for (const [schema, group] of groupBySchema(results)) {
    const variants = recordVariants(schema.ast);
    if (variants.length === 0) {
      continue;
    }
    const covered = new Set(
      group.flatMap((result) =>
        variants.filter((variant) => matchesResultVariant(variant, result.value)).map(variantKey)
      )
    );
    for (const variant of variants) {
      expect(
        covered.has(variantKey(variant)),
        `${context}: ${variantLabel(variant)} has a fixture`
      ).toBe(true);
    }
  }
};

const assertTerminalExit = (input: {
  readonly context: string;
  readonly kind: "success" | "error";
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly success: DurableSchema;
  readonly error: DurableSchema;
}): Option.Option<unknown> => {
  if (input.kind === "success") {
    expect(input.exit._tag, `${input.context}: success exit`).toBe("Success");
    if (input.exit._tag !== "Success") {
      return Option.none();
    }
    encodeJson(input.success, input.exit.value);
    return Option.some(input.exit.value);
  }
  expect(input.exit._tag, `${input.context}: failure exit`).toBe("Failure");
  if (input.exit._tag !== "Failure") {
    return Option.none();
  }
  const fail = Cause.findErrorOption(input.exit.cause);
  expect(Option.isSome(fail), `${input.context}: persisted failure cause contains an error`).toBe(
    true
  );
  if (Option.isNone(fail)) {
    return Option.none();
  }
  encodeJson(input.error, fail.value);
  return Option.some(fail.value);
};

const assertResultForm = (input: {
  readonly context: string;
  readonly form: PersistedResultFixture;
  readonly success: DurableSchema;
  readonly error: DurableSchema;
}): Option.Option<unknown> => {
  const resultSchema = Workflow.Result({ success: input.success, error: input.error });
  const replyCodec = Schema.toCodecJson(Schema.Exit(resultSchema, Schema.Never, Schema.Defect()));
  type DurableReply = (typeof replyCodec)["Type"];
  const decode = (bytes: unknown): DurableReply => Schema.decodeUnknownSync(replyCodec)(bytes);
  const encode = (reply: DurableReply): unknown => Schema.encodeUnknownSync(replyCodec)(reply);
  const assertReply = (context: string, reply: DurableReply): Option.Option<unknown> => {
    if (input.form.kind === "defect") {
      expect(reply._tag, `${context}: persisted defect reply`).toBe("Failure");
      return Option.none();
    }
    expect(reply._tag, `${context}: persisted reply is a successful RPC exit`).toBe("Success");
    if (reply._tag !== "Success") return Option.none();
    const result = reply.value;
    if (input.form.kind === "suspended") {
      expect(result._tag, `${context}: suspended result tag`).toBe("Suspended");
      return Option.none();
    }
    expect(result._tag, `${context}: terminal result tag`).toBe("Complete");
    if (result._tag !== "Complete") return Option.none();
    Schema.encodeUnknownSync(Schema.toCodecJson(resultSchema))(result);
    return assertTerminalExit({
      context,
      kind: input.form.kind,
      exit: result.exit,
      success: input.success,
      error: input.error,
    });
  };
  const reply = decode(input.form.persisted);
  const value = assertReply(input.context, reply);
  const expected = "reencoded" in input.form ? input.form.reencoded : input.form.persisted;
  expect(encode(reply), `${input.context}: persisted reply re-encodes`).toEqual(expected);
  const stable = decode(expected);
  assertReply(`${input.context}: re-encoded`, stable);
  expect(encode(stable), `${input.context}: re-encoded reply is byte-stable`).toEqual(expected);
  if (input.form.current) {
    expect(expected, `${input.context}: current reply is byte-stable`).toEqual(
      input.form.persisted
    );
  }
  return value;
};

const assertPersistedExit = (input: {
  readonly context: string;
  readonly success: DurableSchema;
  readonly error: DurableSchema;
  readonly current: boolean;
  readonly exit: unknown;
  readonly reencoded: unknown;
}): void => {
  const exitCodec = Schema.toCodecJson(
    Schema.Exit(
      Schema.toCodecJson(input.success),
      Schema.toCodecJson(input.error),
      Schema.toCodecJson(Schema.Defect())
    )
  );
  const exit = Schema.decodeUnknownSync(exitCodec)(input.exit);
  expect(exit._tag, `${input.context}: success exit`).toBe("Success");
  const reencoded = Schema.encodeUnknownSync(exitCodec)(exit);
  expect(reencoded, `${input.context}: exit re-encodes`).toEqual(input.reencoded);
  const stable = Schema.decodeUnknownSync(exitCodec)(input.reencoded);
  expect(stable._tag, `${input.context}: re-encoded exit decodes`).toBe("Success");
  expect(
    Schema.encodeUnknownSync(exitCodec)(stable),
    `${input.context}: exit is byte-stable`
  ).toEqual(input.reencoded);
  if (input.current) {
    expect(input.reencoded, `${input.context}: current exit is byte-stable`).toEqual(input.exit);
  }
};

const activitySchemas = (
  activitySpec: DurableActivitySpec
): { readonly success: DurableSchema; readonly error: DurableSchema } => {
  if (!("success" in activitySpec)) {
    return { success: Schema.Void, error: Schema.Never };
  }
  if (!("error" in activitySpec)) {
    return { success: activitySpec.success, error: Schema.Never };
  }
  return { success: activitySpec.success, error: activitySpec.error };
};

/** Mirrors the engine-private Activity primary key in `ClusterWorkflowEngine`; verify on upgrades. */
const activityPrimaryKey = (name: string, attempt: number): string => `${name}/${attempt}`;

const assertActivityResultForms = (
  context: string,
  schemas: { readonly success: DurableSchema; readonly error: DurableSchema },
  resultForms: ReadonlyArray<PersistedResultFixture>
): void => {
  expect(resultForms.length, `${context}: result fixtures`).toBeGreaterThan(0);
  for (const kind of ["suspended", "defect"] as const) {
    expect(
      resultForms.some((result) => result.kind === kind),
      `${context}: ${kind} reply fixture`
    ).toBe(true);
  }
  if (schemas.error !== Schema.Never) {
    expect(
      resultForms.some((result) => result.kind === "error"),
      `${context}: an activity with a typed error has an error result fixture`
    ).toBe(true);
  }
};

const assertActivity = (
  form: PersistedActivityFixture,
  activitySpec: DurableActivitySpec,
  resultForms: ReadonlyArray<PersistedResultFixture>
): ReadonlyArray<DecodedResult> => {
  const context = `activity/${form.key}`;
  const schemas = activitySchemas(activitySpec);
  // The owning compatibility spec supplies the production identity and schemas directly.
  expect(form.requests.length, `${context}: request fixtures`).toBeGreaterThan(0);
  expect(
    form.requests.some((request) => request.current),
    `${context}: current request fixture`
  ).toBe(true);
  expect(
    form.requests.some(
      (request) =>
        Predicate.isObject(request.encoded) &&
        !Predicate.hasProperty(request.encoded, "withTransaction")
    ),
    `${context}: oldest supported request omits withTransaction`
  ).toBe(true);
  const primaryKeys = new Set<string>();
  for (const requestForm of form.requests) {
    const request = decodeActivityRequest(requestForm.encoded);
    expect(request.name, `${context}/${requestForm.label}: persisted request name`).toBe(
      activitySpec.name
    );
    primaryKeys.add(activityPrimaryKey(request.name, request.attempt));
    const expected = "reencoded" in requestForm ? requestForm.reencoded : requestForm.encoded;
    expect(
      encodeActivityRequest(request),
      `${context}/${requestForm.label}: persisted request re-encodes`
    ).toEqual(expected);
    if (requestForm.current) {
      expect(expected, `${context}/${requestForm.label}: current request is byte-stable`).toEqual(
        requestForm.encoded
      );
    }
  }
  expect([...primaryKeys].sort(), `${context}: engine primary keys`).toEqual(
    [...form.primaryKeys].sort()
  );
  assertActivityResultForms(context, schemas, resultForms);
  return resultForms.map((result) => ({
    context: `${context}/${result.label}`,
    schema: result.kind === "success" ? schemas.success : schemas.error,
    value: assertResultForm({
      context: `${context}/${result.label}`,
      form: result,
      success: schemas.success,
      error: schemas.error,
    }),
  }));
};

const assertActivities = (fixture: DurableWorkflowFixture, spec: DurableWorkflowSpec): void => {
  sameKeys(
    "activities",
    fixture.activities.map((activity) => activity.key),
    Object.keys(spec.activities)
  );
  const referencedResultGroups = [...new Set(fixture.activities.map((form) => form.resultGroup))];
  sameKeys(
    "activity result groups",
    Object.keys(fixture.activityResultGroups),
    referencedResultGroups
  );
  const results: Array<DecodedResult> = [];
  for (const form of fixture.activities) {
    const activitySpec = spec.activities[form.key];
    expect(activitySpec, `activity ${form.key} is declared`).toBeDefined();
    if (activitySpec === undefined) {
      continue;
    }
    const resultForms = fixture.activityResultGroups[form.resultGroup];
    expect(resultForms, `activity result group ${form.resultGroup} is declared`).toBeDefined();
    if (resultForms !== undefined) results.push(...assertActivity(form, activitySpec, resultForms));
  }
  assertResultVariants("activity result", results);
};

const assertClock = (
  form: PersistedClockFixture,
  clockSpec: DurableClockSpec,
  workflowTag: string
): void => {
  const context = `clock/${form.key}`;
  expect(form.name, `${context}: clock name`).toBe(clockSpec.name);
  expect(form.deferredName, `${context}: deferred name`).toBe(`DurableClock/${clockSpec.name}`);
  const clock = DurableClock.make({ name: clockSpec.name, duration: "1 minute" });
  expect(clock.deferred.name, `${context}: production deferred name`).toBe(form.deferredName);
  const request = decodeClockRequest(form.request);
  expect(request.name, `${context}: persisted request name`).toBe(form.name);
  expect(request.workflowName, `${context}: persisted request workflow`).toBe(workflowTag);
  expect(encodeClockRequest(request), `${context}: persisted request re-encodes`).toEqual(
    form.request
  );
  expect(form.completion.name, `${context}: completion request name`).toBe(form.deferredName);
  const completion = decodeDeferredRequest(form.completion.request);
  expect(completion.name, `${context}: completion name`).toBe(form.deferredName);
  assertPersistedExit({
    context,
    success: clockSpec.success,
    error: clockSpec.error,
    current: form.completion.current,
    exit: form.completion.exit,
    reencoded: "reencoded" in form.completion ? form.completion.reencoded : form.completion.exit,
  });
  expect(encodeDeferredRequest(completion), `${context}: completion request re-encodes`).toEqual(
    form.completion.request
  );
};

const assertClocks = (fixture: DurableWorkflowFixture, spec: DurableWorkflowSpec): void => {
  sameKeys(
    "clocks",
    fixture.clocks.map((clock) => clock.key),
    Object.keys(spec.clocks)
  );
  for (const form of fixture.clocks) {
    const clockSpec = spec.clocks[form.key];
    expect(clockSpec, `clock ${form.key} is declared`).toBeDefined();
    if (clockSpec === undefined) {
      continue;
    }
    assertClock(form, clockSpec, fixture.workflow.tag);
  }
};

const assertDeferred = (
  form: PersistedDeferredFixture,
  deferredSpec: DurableDeferredSpec
): void => {
  const context = `deferred/${form.key}`;
  expect(form.raceAll, `${context}: raceAll form`).toBe(deferredSpec.raceAll);
  const persistedName = deferredSpec.raceAll ? `raceAll/${deferredSpec.name}` : deferredSpec.name;
  // The awaited name and completion schemas are pinned statically at the call site; the persisted
  // request and exit below are decoded with the production identity the owning test passes in.
  expect(form.name, `${context}: persisted deferred name`).toBe(persistedName);
  const request = decodeDeferredRequest(form.request);
  expect(request.name, `${context}: persisted request name`).toBe(persistedName);
  assertPersistedExit({
    context,
    success: deferredSpec.success,
    error: deferredSpec.error,
    current: form.current,
    exit: form.exit,
    reencoded: "reencoded" in form ? form.reencoded : form.exit,
  });
  expect(encodeDeferredRequest(request), `${context}: persisted request re-encodes`).toEqual(
    form.request
  );
};

const assertDeferreds = (fixture: DurableWorkflowFixture, spec: DurableWorkflowSpec): void => {
  sameKeys(
    "deferreds",
    fixture.deferreds.map((deferred) => deferred.key),
    Object.keys(spec.deferreds)
  );
  for (const form of fixture.deferreds) {
    const deferredSpec = spec.deferreds[form.key];
    expect(deferredSpec, `deferred ${form.key} is declared`).toBeDefined();
    if (deferredSpec === undefined) {
      continue;
    }
    assertDeferred(form, deferredSpec);
  }
};

const assertResults = (fixture: DurableWorkflowFixture, spec: DurableWorkflowSpec): void => {
  expect(fixture.results.length, "workflow result fixtures").toBeGreaterThan(0);
  expect(
    fixture.results.some((form) => form.current),
    "at least one result fixture is the current encoding"
  ).toBe(true);
  if (spec.errorSchema !== Schema.Never) {
    expect(
      fixture.results.some((form) => form.kind === "error"),
      "a workflow with a typed error has an error result fixture"
    ).toBe(true);
  }
  const results = fixture.results.map((form): DecodedResult => ({
    context: `result/${form.label}`,
    schema: form.kind === "success" ? spec.successSchema : spec.errorSchema,
    value: assertResultForm({
      context: `result/${form.label}`,
      form,
      success: spec.successSchema,
      error: spec.errorSchema,
    }),
  }));
  assertResultVariants("workflow result", results);
};

const assertWorkflowSpec = (fixture: DurableWorkflowFixture, spec: DurableWorkflowSpec): void => {
  expect(fixture.workflow.tag, "workflow tag is a deployment contract").toBe(spec.workflow._tag);
  expect(spec.payloadSchema, "payload schema is the workflow's declaration").toBe(
    spec.workflow.payloadSchema
  );
  expect(spec.successSchema, "success schema is the workflow's declaration").toBe(
    spec.workflow.successSchema
  );
  expect(spec.errorSchema, "error schema is the workflow's declaration").toBe(
    spec.workflow.errorSchema
  );
  expect(fixture.payloads.length, "workflow payload fixtures").toBeGreaterThan(0);
  expect(
    fixture.payloads.some((form) => form.current),
    "at least one payload fixture is the current encoding"
  ).toBe(true);
  assertEncodedShape({
    context: "resume",
    form: fixture.resume,
    schema: PersistedResumeRequest,
  });
  expect(fixture.resume.primaryKey, "resume: engine primary key").toBe("");
};

const assertPayloads = Effect.fn("assertDurableWorkflowFixture.payloads")(function* (
  fixture: DurableWorkflowFixture,
  spec: DurableWorkflowSpec
) {
  const results: Array<DecodedResult> = [];
  for (const form of fixture.payloads) {
    const context = `payload/${form.label}`;
    const payload = assertEncodedShape({
      context,
      form,
      schema: spec.payloadSchema,
    });
    expect(spec.workflow.idempotencyKey(payload), `${context}: idempotency key`).toBe(
      form.idempotencyKey
    );
    expect(yield* spec.workflow.executionId(payload), `${context}: execution id`).toBe(
      form.executionId
    );
    results.push({ context, schema: spec.payloadSchema, value: Option.some(payload) });
  }
  assertRecordVariants("workflow payload", results);
});

const assertQueue = Effect.fn("assertDurableWorkflowFixture.queue")(function* (
  form: PersistedQueueFixture,
  queueSpec: DurableQueueSpec
) {
  expect(form.name, `queue/${form.key}: queue name`).toBe(queueSpec.name);
  expect(form.payloads.length, `queue/${form.key}: payload fixtures`).toBeGreaterThan(0);
  const results: Array<DecodedResult> = [];
  for (const payload of form.payloads) {
    const context = `queue/${form.key}/${payload.label}`;
    const decoded = assertEncodedShape({ context, form: payload, schema: queueSpec.schema });
    expect(yield* queueSpec.queueId(decoded), `${context}: queue id`).toBe(payload.id);
    results.push({ context, schema: queueSpec.schema, value: Option.some(decoded) });
  }
  return results;
});

const assertQueueFixtures = Effect.fn("assertQueueFixtures")(function* (
  forms: ReadonlyArray<PersistedQueueFixture>,
  specs: ReadonlyArray<DurableQueueSpec>
) {
  sameKeys(
    "queues",
    forms.map((queue) => queue.key),
    specs.map((queue) => queue.key)
  );
  const results: Array<DecodedResult> = [];
  for (const form of forms) {
    const queueSpec = specs.find((queue) => queue.key === form.key);
    expect(queueSpec, `queue ${form.key} is declared`).toBeDefined();
    if (queueSpec === undefined) {
      continue;
    }
    results.push(...(yield* assertQueue(form, queueSpec)));
  }
  assertRecordVariants("queue payload", results);
});

const assertQueues = Effect.fn("assertDurableWorkflowFixture.queues")(function* (
  fixture: DurableWorkflowFixture,
  spec: DurableWorkflowSpec
) {
  yield* assertQueueFixtures(fixture.queues, spec.queues);
});

/** Decodes and identity-checks every standalone durable queue fixture. */
export const assertStandaloneDurableQueueFixture = Effect.fn("assertStandaloneDurableQueueFixture")(
  function* (fixture: StandaloneDurableQueueFixture, specs: ReadonlyArray<DurableQueueSpec>) {
    yield* assertQueueFixtures(fixture.queues, specs);
  }
);

/**
 * Asserts that every persisted boundary of one Workflow decodes the checked-in fixture bytes with
 * the current production schemas, preserves identity, and re-encodes to the same (or a documented
 * additive) shape.
 */
export const assertDurableWorkflowFixture = Effect.fn("assertDurableWorkflowFixture")(function* (
  fixture: DurableWorkflowFixture,
  spec: DurableWorkflowSpec
) {
  assertWorkflowSpec(fixture, spec);
  yield* assertPayloads(fixture, spec);
  assertResults(fixture, spec);
  assertActivities(fixture, spec);
  assertClocks(fixture, spec);
  assertDeferreds(fixture, spec);
  yield* assertQueues(fixture, spec);
});
