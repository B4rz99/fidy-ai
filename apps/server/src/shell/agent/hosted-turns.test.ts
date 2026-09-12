import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Option, PrimaryKey, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { UserId } from "~/core/identity/reference";
import { TranscriptText, TranscriptTurnId } from "~/core/transcript/model";
import type { CanonicalAuthorityRoot } from "~/shell/_shared/operation-policy";
import { WhatsAppInboundJobId } from "~/shell/channels/whatsapp/model";
import { AgentLimits, type HostedTurnRpc, HostedTurns, TurnFailure } from "./hosted-turns";
import { AgentReply, InboundMessage } from "./message";

type HostedTurnTag = HostedTurnRpc["_tag"];

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

/** The UUID JSON Schema fragment shared by every wire identifier, inlined into the pinned documents. */
const uuidSchema = {
  type: "string",
  pattern:
    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$",
  format: "uuid",
};

/** The transcript text codec shared by inbound messages, replies, and reply choices. */
const transcriptTextSchema = {
  type: "string",
  minLength: 1,
  maxLength: 16000,
  pattern: "\\S",
};

/** One provider message reference inside confirmation evidence. */
const providerMessageEvidenceSchema = {
  type: "object",
  properties: {
    channel: {
      type: "string",
      minLength: 1,
      pattern: "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      maxLength: 32,
    },
    provider: {
      type: "string",
      minLength: 1,
      pattern: "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      maxLength: 64,
    },
    providerMessageId: {
      type: "string",
      minLength: 1,
      pattern: "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      maxLength: 256,
    },
  },
  required: ["channel", "provider", "providerMessageId"],
  additionalProperties: false,
};

/** One deliverable media reference in an agent reply. */
const attachmentSchema = {
  type: "object",
  properties: {
    mediaType: {
      type: "string",
      minLength: 1,
    },
    url: {
      type: "string",
    },
  },
  required: ["mediaType", "url"],
  additionalProperties: false,
};

/** One follow-up action in an agent reply. */
const choiceSchema = {
  type: "object",
  properties: {
    label: {
      type: "string",
      minLength: 1,
    },
    message: transcriptTextSchema,
  },
  required: ["label", "message"],
  additionalProperties: false,
};

/** Success document of an operation that returns void. */
const voidSuccessDocument: unknown = {
  dialect: "draft-2020-12",
  schema: {
    type: "null",
  },
  definitions: {},
};

/** Error document of an operation that declares no failure. */
const voidErrorDocument: unknown = {
  dialect: "draft-2020-12",
  schema: {
    not: {},
  },
  definitions: {},
};

/**
 * Complete JSON Schema documents for the HostedTurns wire contract. Every reference is inlined
 * (`wireDocument` below), so the pinned structure does not depend on Effect's generated definition
 * names. These expectations are the reviewed oracle: the codecs themselves come from the one
 * production entity definition, so any schema-representable change to a payload, result, error, or
 * referenced codec fails this suite until the wire contract is deliberately re-reviewed. Codec
 * refinements with no JSON Schema projection (for example canonical UUID casing) are pinned by the
 * rejection fixtures instead.
 */
const handlePayloadDocument: unknown = {
  dialect: "draft-2020-12",
  schema: {
    type: "object",
    properties: {
      userId: uuidSchema,
      turnId: uuidSchema,
      message: {
        type: "object",
        properties: {
          text: transcriptTextSchema,
          confirmationEvidence: {
            type: "object",
            properties: {
              _tag: {
                type: "string",
                enum: ["ProviderQualifiedMessages"],
              },
              disclosureMessage: providerMessageEvidenceSchema,
              decisionMessage: providerMessageEvidenceSchema,
            },
            required: ["_tag", "disclosureMessage", "decisionMessage"],
            additionalProperties: false,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      limits: {
        type: "object",
        properties: {
          maxIterations: {
            type: "integer",
            minimum: 1,
            maximum: 32,
          },
          maxToolCallsPerTurn: {
            type: "integer",
            minimum: 1,
            maximum: 64,
          },
          maxToolResultCharacters: {
            type: "integer",
            minimum: 1000,
            maximum: 1000000,
          },
          maxModelRoundMillis: {
            type: "integer",
            minimum: 1,
            maximum: 120000,
          },
        },
        required: [
          "maxIterations",
          "maxToolCallsPerTurn",
          "maxToolResultCharacters",
          "maxModelRoundMillis",
        ],
        additionalProperties: false,
      },
      authorityRoot: {
        type: "string",
        enum: ["no-verified-whatsapp-authority", "verified-whatsapp"],
      },
    },
    required: ["userId", "turnId", "message", "limits", "authorityRoot"],
    additionalProperties: false,
  },
  definitions: {},
};

const handleSuccessDocument: unknown = {
  dialect: "draft-2020-12",
  schema: {
    type: "object",
    properties: {
      text: transcriptTextSchema,
      attachments: {
        type: "array",
        prefixItems: [attachmentSchema],
        minItems: 1,
        items: attachmentSchema,
      },
      choices: {
        type: "array",
        prefixItems: [choiceSchema],
        minItems: 1,
        items: choiceSchema,
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  definitions: {},
};

const handleErrorDocument: unknown = {
  dialect: "draft-2020-12",
  schema: {
    type: "string",
    enum: declaredTurnFailures,
  },
  definitions: {},
};

const whatsAppPayloadDocument: unknown = {
  dialect: "draft-2020-12",
  schema: {
    type: "object",
    properties: {
      version: {
        type: "number",
        enum: [1],
      },
      userId: uuidSchema,
      inboundJobId: uuidSchema,
    },
    required: ["version", "userId", "inboundJobId"],
    additionalProperties: false,
  },
  definitions: {},
};

const recoverPayloadDocument: unknown = {
  dialect: "draft-2020-12",
  schema: {
    type: "object",
    properties: {
      userId: uuidSchema,
      turnId: uuidSchema,
    },
    required: ["userId", "turnId"],
    additionalProperties: false,
  },
  definitions: {},
};

/**
 * The tested HostedTurns wire contract: one reviewed expectation per operation, derived from the
 * one production entity definition. Fixtures exercise the generated client; the pinned JSON Schema
 * documents, annotations, and primary keys catch protocol changes the fixtures would not reach.
 */
type HostedTurnContract = Readonly<{
  readonly persisted: boolean;
  readonly clientUninterruptible: boolean;
  readonly serverUninterruptible: boolean;
  /** Payload fixture the generated client must accept. */
  readonly payload: unknown;
  /** Payloads the generated client must reject, one per reviewed input constraint. */
  readonly rejectedPayloads: ReadonlyArray<unknown>;
  /** Complete inlined JSON Schema document of the operation's payload codec. */
  readonly payloadDocument: unknown;
  /** Result fixture the generated client must accept. */
  readonly result: unknown;
  /** Results the generated client must reject, one per reviewed output constraint. */
  readonly rejectedResults: ReadonlyArray<unknown>;
  /** Complete inlined JSON Schema document of the operation's success codec. */
  readonly successDocument: unknown;
  readonly failure: Option.Option<unknown>;
  /** Complete inlined JSON Schema document of the operation's error codec. */
  readonly errorDocument: unknown;
  readonly primaryKey: Option.Option<string>;
}>;

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
const authorityRoot: CanonicalAuthorityRoot = "no-verified-whatsapp-authority";
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
    // Dropping the canonical lowercase UUID filter would admit this value.
    { ...handlePayload, turnId: turnId.toUpperCase() },
    // Dropping the canonical JSON-string filter would admit this value.
    { ...handlePayload, message: { text: "nul\u0000text" } },
  ],
  payloadDocument: handlePayloadDocument,
  result: AgentReply.make({
    text: TranscriptText.make("Contrato verificado"),
    attachments: Option.none(),
    choices: Option.none(),
  }),
  rejectedResults: [
    { text: "" },
    { text: "present", attachments: [] },
    // Dropping URL validation would admit this value.
    { text: "present", attachments: [{ mediaType: "image/png", url: "not a url" }] },
  ],
  successDocument: handleSuccessDocument,
  failure: Option.some(TurnFailure.make("UnknownUser")),
  errorDocument: handleErrorDocument,
  primaryKey: Option.none(),
};

const whatsAppContract: HostedTurnContract = {
  persisted: true,
  clientUninterruptible: true,
  serverUninterruptible: false,
  payload: { version: 1, userId, inboundJobId },
  rejectedPayloads: [{ version: 2, userId, inboundJobId }],
  payloadDocument: whatsAppPayloadDocument,
  result: undefined,
  rejectedResults: [],
  successDocument: voidSuccessDocument,
  failure: Option.none(),
  errorDocument: voidErrorDocument,
  primaryKey: Option.some(inboundJobId),
};

const recoverContract: HostedTurnContract = {
  persisted: true,
  clientUninterruptible: true,
  serverUninterruptible: false,
  payload: { userId, turnId },
  rejectedPayloads: [
    { userId: "not-a-uuid", turnId },
    // Dropping the canonical lowercase UUID filter would admit this value.
    { userId, turnId: turnId.toUpperCase() },
  ],
  payloadDocument: recoverPayloadDocument,
  result: undefined,
  rejectedResults: [],
  successDocument: voidSuccessDocument,
  failure: Option.none(),
  errorDocument: voidErrorDocument,
  primaryKey: Option.some(turnId),
};

/** Compile-time completeness: adding or removing an operation fails here until it has a contract. */
const contract: Record<HostedTurnTag, HostedTurnContract> = {
  Handle: handleContract,
  ProcessWhatsApp: whatsAppContract,
  Recover: recoverContract,
};

/** The codec's complete JSON Schema document with every reference inlined into the pinned shape. */
const wireDocument = (schema: Schema.Top): unknown =>
  Schema.toJsonSchemaDocument(schema, { referencePolicy: () => undefined });

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

    expect(wireDocument(request.payloadSchema)).toEqual(expected.payloadDocument);

    // Ops with a primary key carry a payload class, so decode first and round-trip through its codec.
    const decodedPayload = yield* Schema.decodeUnknownEffect(request.payloadSchema)(
      expected.payload
    );
    const encodedPayload = yield* Schema.encodeUnknownEffect(request.payloadSchema)(decodedPayload);
    expect(encodedPayload).toEqual(expected.payload);
    for (const rejected of expected.rejectedPayloads) {
      const attempt = yield* Schema.decodeUnknownEffect(request.payloadSchema)(rejected).pipe(
        Effect.exit
      );
      expect(Exit.isFailure(attempt)).toBe(true);
    }
    if (Option.isSome(expected.primaryKey)) {
      if (!PrimaryKey.isPrimaryKey(decodedPayload)) {
        return yield* Effect.die(`expected ${tag} payload to define a primary key`);
      }
      expect(PrimaryKey.value(decodedPayload)).toBe(expected.primaryKey.value);
    } else {
      expect(PrimaryKey.isPrimaryKey(decodedPayload)).toBe(false);
    }

    expect(wireDocument(request.successSchema)).toEqual(expected.successDocument);
    const encodedResult = yield* Schema.encodeUnknownEffect(request.successSchema)(expected.result);
    expect(yield* Schema.decodeEffect(request.successSchema)(encodedResult)).toEqual(
      expected.result
    );
    for (const rejected of expected.rejectedResults) {
      const attempt = yield* Schema.decodeUnknownEffect(request.successSchema)(rejected).pipe(
        Effect.exit
      );
      expect(Exit.isFailure(attempt)).toBe(true);
    }

    expect(wireDocument(request.errorSchema)).toEqual(expected.errorDocument);
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
  })
);

it.effect("pins the Handle wire contract", () => checkContract("Handle", handleContract));

it.effect("pins the ProcessWhatsApp wire contract", () =>
  checkContract("ProcessWhatsApp", whatsAppContract)
);

it.effect("pins the Recover wire contract", () => checkContract("Recover", recoverContract));
