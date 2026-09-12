import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Option, PrimaryKey, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { UserId } from "~/core/identity/reference";
import { TranscriptText, TranscriptTurnId } from "~/core/transcript/model";
import { WhatsAppInboundJobId } from "~/shell/channels/whatsapp/model";
import { AgentLimits, type HostedTurnRpc, HostedTurns, TurnFailure } from "./hosted-turns";
import { AgentReply, InboundMessage } from "./message";

type HostedTurnTag = HostedTurnRpc["_tag"];

/** Property names and required keys of a codec's JSON object schema. */
type DeclaredShape = Readonly<{
  readonly properties: ReadonlyArray<string>;
  readonly required: ReadonlyArray<string>;
}>;

/**
 * The tested HostedTurns wire contract. Schemas, tags, and generated clients come from the one
 * production entity definition; the expectations below are the reviewed oracle, deliberately
 * independent of it, so a protocol change that the tests do not reflect fails this suite before
 * it can reach a runner.
 */
type HostedTurnContract = Readonly<{
  readonly persisted: boolean;
  readonly clientUninterruptible: boolean;
  readonly serverUninterruptible: boolean;
  /** Payload fixture the generated client must accept. */
  readonly payload: unknown;
  /** Payloads the generated client must reject, one per declared input constraint. */
  readonly rejectedPayloads: ReadonlyArray<unknown>;
  readonly payloadShape: DeclaredShape;
  /** Nested payload constraints pinned without restating the whole schema. */
  readonly payloadConstraints: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  /** Results the generated client must reject, one per declared output constraint. */
  readonly rejectedResults: ReadonlyArray<unknown>;
  readonly successShape: DeclaredShape;
  readonly successConstraints: Readonly<Record<string, unknown>>;
  readonly failure: Option.Option<unknown>;
  /** Exact JSON Schema root of the operation's declared error codec. */
  readonly errorSchema: unknown;
  readonly primaryKey: Option.Option<string>;
}>;

/** The reviewed closed failure vocabulary: a runner may only return these literals. */
const declaredTurnFailures = [
  "UnknownUser",
  "OnboardingConsentRequired",
  "HostedCapacityExceeded",
  "ModelUnavailable",
  "ModelResponseRejected",
  "HostedTurnAlreadyHandled",
  "HostedTurnUnavailable",
  "delivery_failed",
] as const satisfies ReadonlyArray<TurnFailure>;

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000507");
const turnId = TranscriptTurnId.make("018f0f5e-0000-7000-8000-000000000507");
const inboundJobId = WhatsAppInboundJobId.make("018f0f5e-0000-4000-8000-000000000508");
const limits = AgentLimits.make({
  maxIterations: 6,
  maxToolCallsPerTurn: 12,
  maxToolResultCharacters: 32_000,
  maxModelRoundMillis: 30_000,
});
const message = InboundMessage.make({ text: TranscriptText.make("wire contract") });
const authorityRoot: "no-verified-whatsapp-authority" | "verified-whatsapp" =
  "no-verified-whatsapp-authority";
const handlePayload = { userId, turnId, message, limits, authorityRoot };

const handleContract: HostedTurnContract = {
  persisted: false,
  clientUninterruptible: true,
  serverUninterruptible: false,
  payload: handlePayload,
  rejectedPayloads: [
    // Dropping an AgentLimits bound would admit this value.
    { ...handlePayload, limits: { ...limits, maxIterations: 33 } },
    // Widening the authority vocabulary would admit this value.
    { ...handlePayload, authorityRoot: "trusted-internal" },
  ],
  payloadShape: {
    properties: ["authorityRoot", "limits", "message", "turnId", "userId"],
    required: ["authorityRoot", "limits", "message", "turnId", "userId"],
  },
  payloadConstraints: {
    type: "object",
    additionalProperties: false,
    properties: {
      authorityRoot: {
        type: "string",
        enum: ["no-verified-whatsapp-authority", "verified-whatsapp"],
      },
    },
  },
  result: AgentReply.make({
    text: TranscriptText.make("Contrato verificado"),
    attachments: Option.none(),
    choices: Option.none(),
  }),
  successShape: {
    properties: ["attachments", "choices", "text"],
    required: ["text"],
  },
  rejectedResults: [{ text: "" }, { text: "present", attachments: [] }],
  successConstraints: { type: "object", additionalProperties: false },
  failure: Option.some(TurnFailure.make("UnknownUser")),
  errorSchema: { type: "string", enum: declaredTurnFailures },
  primaryKey: Option.none(),
};

const whatsAppContract: HostedTurnContract = {
  persisted: true,
  clientUninterruptible: true,
  serverUninterruptible: false,
  payload: { version: 1, userId, inboundJobId },
  rejectedPayloads: [{ version: 2, userId, inboundJobId }],
  payloadShape: {
    properties: ["inboundJobId", "userId", "version"],
    required: ["inboundJobId", "userId", "version"],
  },
  payloadConstraints: {
    type: "object",
    additionalProperties: false,
    properties: { version: { type: "number", enum: [1] } },
  },
  result: undefined,
  rejectedResults: [],
  successShape: { properties: [], required: [] },
  successConstraints: { type: "null" },
  failure: Option.none(),
  errorSchema: { not: {} },
  primaryKey: Option.some(inboundJobId),
};

const recoverContract: HostedTurnContract = {
  persisted: true,
  clientUninterruptible: true,
  serverUninterruptible: false,
  payload: { userId, turnId },
  rejectedPayloads: [{ userId: "not-a-uuid", turnId }],
  payloadShape: {
    properties: ["turnId", "userId"],
    required: ["turnId", "userId"],
  },
  payloadConstraints: { type: "object", additionalProperties: false },
  result: undefined,
  rejectedResults: [],
  successShape: { properties: [], required: [] },
  successConstraints: { type: "null" },
  failure: Option.none(),
  errorSchema: { not: {} },
  primaryKey: Option.some(turnId),
};

/** Compile-time completeness: adding or removing an operation fails here until it has a contract. */
const contract: Record<HostedTurnTag, HostedTurnContract> = {
  Handle: handleContract,
  ProcessWhatsApp: whatsAppContract,
  Recover: recoverContract,
};

/** Follows the single `$ref` an operation codec emits, so shape assertions see its object codec. */
const resolveRoot = (schema: Schema.Top): Readonly<Record<string, unknown>> => {
  const document = Schema.toJsonSchemaDocument(schema);
  const root = document.schema;
  const ref = root["$ref"];
  if (typeof ref !== "string") return root;
  const name = ref
    .slice(ref.lastIndexOf("/") + 1)
    .replaceAll("~1", "/")
    .replaceAll("~0", "~");
  const resolved = document.definitions[name];
  if (resolved === undefined) throw new Error(`missing JSON Schema definition ${ref}`);
  return resolved;
};

const declaredShape = (root: Readonly<Record<string, unknown>>): DeclaredShape => {
  const properties = root["properties"];
  const required = root["required"];
  return {
    properties:
      typeof properties === "object" && properties !== null ? Object.keys(properties).sort() : [],
    required: Array.isArray(required) ? required.map(String).sort() : [],
  };
};

const checkContract = (
  tag: HostedTurnTag,
  expected: HostedTurnContract
): Effect.Effect<void, Schema.SchemaError> =>
  Effect.gen(function* () {
    const request = Option.getOrThrow(
      Option.fromUndefinedOr(HostedTurns.protocol.requests.get(tag))
    );
    expect(Context.get(request.annotations, ClusterSchema.Persisted)).toBe(expected.persisted);
    expect(ClusterSchema.isUninterruptibleForClient(request.annotations)).toBe(
      expected.clientUninterruptible
    );
    expect(ClusterSchema.isUninterruptibleForServer(request.annotations)).toBe(
      expected.serverUninterruptible
    );

    const payloadRoot = resolveRoot(request.payloadSchema);
    expect(declaredShape(payloadRoot)).toEqual(expected.payloadShape);
    expect(payloadRoot).toMatchObject(expected.payloadConstraints);

    // Ops with a primary key carry a payload class, so decode first and round-trip through its codec.
    const decodedPayload = yield* Schema.decodeUnknownEffect(request.payloadSchema)(
      expected.payload
    );
    const encodedPayload = yield* Schema.encodeUnknownEffect(request.payloadSchema)(decodedPayload);
    expect(encodedPayload).toEqual(expected.payload);
    for (const rejected of expected.rejectedPayloads) {
      const decoded = yield* Schema.decodeUnknownEffect(request.payloadSchema)(rejected).pipe(
        Effect.exit
      );
      expect(Exit.isFailure(decoded)).toBe(true);
    }
    if (Option.isSome(expected.primaryKey)) {
      if (!PrimaryKey.isPrimaryKey(decodedPayload)) {
        return yield* Effect.die(`expected ${tag} payload to define a primary key`);
      }
      expect(PrimaryKey.value(decodedPayload)).toBe(expected.primaryKey.value);
    } else {
      expect(PrimaryKey.isPrimaryKey(decodedPayload)).toBe(false);
    }

    const successRoot = resolveRoot(request.successSchema);
    expect(declaredShape(successRoot)).toEqual(expected.successShape);
    expect(successRoot).toMatchObject(expected.successConstraints);
    const encodedResult = yield* Schema.encodeUnknownEffect(request.successSchema)(expected.result);
    expect(yield* Schema.decodeEffect(request.successSchema)(encodedResult)).toEqual(
      expected.result
    );
    for (const rejected of expected.rejectedResults) {
      const decoded = yield* Schema.decodeUnknownEffect(request.successSchema)(rejected).pipe(
        Effect.exit
      );
      expect(Exit.isFailure(decoded)).toBe(true);
    }

    // NoError ops emit `{ not: {} }`, so this also proves the operation cannot declare a failure.
    expect(Schema.toJsonSchemaDocument(request.errorSchema).schema).toEqual(expected.errorSchema);
    if (Option.isSome(expected.failure)) {
      const encodedFailure = yield* Schema.encodeUnknownEffect(request.errorSchema)(
        expected.failure.value
      );
      expect(yield* Schema.decodeEffect(request.errorSchema)(encodedFailure)).toEqual(
        expected.failure.value
      );
    }
  });

it.effect("pins the complete HostedTurns operation set", () =>
  Effect.sync(() => {
    expect(HostedTurns.type).toBe("HostedTurns");
    expect(Object.keys(contract).sort()).toEqual([...HostedTurns.protocol.requests.keys()].sort());
    expect([...HostedTurns.protocol.requests.keys()].sort()).toEqual([
      "Handle",
      "ProcessWhatsApp",
      "Recover",
    ]);
  })
);

it("pins the closed TurnFailure vocabulary", () => {
  expect(Schema.toJsonSchemaDocument(TurnFailure).schema).toEqual({
    type: "string",
    enum: declaredTurnFailures,
  });
});

it("pins every declared AgentLimits bound", () => {
  expect(Schema.toJsonSchemaDocument(AgentLimits).schema).toEqual({
    type: "object",
    properties: {
      maxIterations: { type: "integer", minimum: 1, maximum: 32 },
      maxToolCallsPerTurn: { type: "integer", minimum: 1, maximum: 64 },
      maxToolResultCharacters: { type: "integer", minimum: 1000, maximum: 1000000 },
      maxModelRoundMillis: { type: "integer", minimum: 1, maximum: 120000 },
    },
    required: [
      "maxIterations",
      "maxToolCallsPerTurn",
      "maxToolResultCharacters",
      "maxModelRoundMillis",
    ],
    additionalProperties: false,
  });
});

it.effect("pins the Handle wire contract", () => checkContract("Handle", handleContract));

it.effect("pins the ProcessWhatsApp wire contract", () =>
  checkContract("ProcessWhatsApp", whatsAppContract)
);

it.effect("pins the Recover wire contract", () => checkContract("Recover", recoverContract));
