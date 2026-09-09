import { Crypto, DateTime, Effect, Encoding, Layer, Option, Schema } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { HttpBody, HttpClient } from "effect/unstable/http";
import * as XLSX from "xlsx/xlsx.mjs";
import type { CanonicalOperationId } from "~/core/audit/model";
import { UserId } from "~/core/identity/reference";
import {
  Base64FileContent,
  ReceivedEmailContent,
  StatementIdempotencyKey,
  type SubmitForExtractionInput,
} from "~/core/ingestion/model";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { TranscriptText } from "~/core/transcript/model";
import { AgentService, InboundMessage } from "~/shell/agent/agent-service";
import { FidyApi, operationCatalog } from "~/shell/api";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { makeTokenAuthorizationClientLive } from "~/shell/_shared/authz";
import {
  generateDevelopmentPatBearer,
  seedConsentedPatIdentity,
} from "~/shell/db/development-seed";
import { ForwardedEmailProcessor } from "~/shell/ingestion/forwarded-email-ingestion";
import { ResendReceivingClient } from "~/shell/ingestion/resend-receiving-client";
import { processNextStatement } from "~/shell/ingestion/worker";
import type { ApiClient } from "~/shell/testing/api-harness";
import { signResendWebhook } from "~/shell/testing/sign-resend-webhook";
import type { LoadedCorpus } from "./corpus";
import {
  type CheckResult,
  type EmailCase,
  EvaluationFailure,
  type FinancialFacts,
  type HostedCase,
  type StatementCase,
} from "./model";
import { check, sameFinancialFacts, scoreObservation } from "./scoring";
import { UnknownJsonString } from "~/schema-compatibility";

/** New User and PAT per case/repetition: no prior Transcript, mapping cache, quota or replay state. */
export const makeScenario = Effect.fn("Evaluation.makeScenario")(function* () {
  const crypto = yield* Crypto.Crypto;
  const userId = UserId.make(yield* crypto.randomUUIDv4);
  const bearer = yield* generateDevelopmentPatBearer;
  yield* seedConsentedPatIdentity({ userId, bearer });
  const authorization = yield* Layer.build(makeTokenAuthorizationClientLive(bearer));
  const client = yield* HttpApiClient.make(FidyApi).pipe(Effect.provide(authorization));
  return { userId, client };
});
export type Scenario = Effect.Success<ReturnType<typeof makeScenario>>;

/** Synthetic setup crosses canonical mutations, preserving Category and audit behavior. */
export const seedTransactions = Effect.fn("Evaluation.seedTransactions")(function* (
  client: ApiClient,
  facts: ReadonlyArray<FinancialFacts>
) {
  return yield* Effect.forEach(
    facts,
    (fact) =>
      client.transactions.createTransaction({
        payload: {
          ...fact,
          categoryId: Option.some(fact.categoryId),
          notes: Option.none(),
        },
      }),
    { concurrency: 1 }
  );
});

/** Only canonical projections are used for financial and review scoring. */
export const observeScenario = Effect.fn("Evaluation.observeScenario")(function* (
  client: ApiClient
) {
  const facts = (yield* client.transactions.listTransactions({ query: {} })).data;
  const reviews = (yield* client.ingestion.listNeedsReviewItems({
    query: { offset: Option.none(), limit: Option.none() },
  })).data;
  return { facts, reviews };
});

const extractChallenge = (reply: string): Option.Option<string> =>
  Option.fromUndefinedOr(/Responde exactamente: (CONFIRMAR [^\n]+)/u.exec(reply)?.[1]);

const hostedStepText = (
  step: HostedCase["steps"][number],
  firstId: Option.Option<string>,
  challenge: Option.Option<string>
): string => {
  if (step.kind === "message") return step.text;
  if (step.kind === "delete-first" && Option.isSome(firstId)) {
    return `Elimina la transacción con id ${firstId.value}. Solicita mi confirmación antes de borrarla.`;
  }
  if (step.kind === "confirm" && Option.isSome(challenge)) return challenge.value;
  return "";
};

const validDelivery = (count: number, reply: string): boolean =>
  count === 1 && reply.trim().length > 0;

const hostedInbound = (step: HostedCase["steps"][number], text: string): InboundMessage => {
  if (step.kind !== "confirm") return InboundMessage.make({ text: TranscriptText.make(text) });
  return InboundMessage.make({
    text: TranscriptText.make(text),
    confirmationEvidence: {
      _tag: "ProviderQualifiedMessages",
      disclosureMessage: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: "wamid.evaluation-disclosure",
      },
      decisionMessage: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: "wamid.evaluation-decision",
      },
    },
  });
};

const safeBeforeConfirmation = (
  challenge: Option.Option<string>,
  expected: ReadonlyArray<FinancialFacts>,
  observed: ReadonlyArray<FinancialFacts>
): boolean => Option.isSome(challenge) && sameFinancialFacts(expected, observed);

const mutationNames = new Set(
  operationCatalog.operations
    .filter((operation) => operation.policy.kind === "mutation")
    .map((operation) => operation.id)
);

const normalizeReplyEvidence = (text: string): string =>
  text.normalize("NFD").replaceAll(/\p{M}/gu, "").toLocaleLowerCase("es-CO");

const replyRubricMatches = (
  entry: HostedCase,
  replies: ReadonlyArray<string>,
  sawChallenge: boolean
): boolean => {
  const replyText = normalizeReplyEvidence(replies.join("\n"));
  const includesEvidence = entry.replyIncludes.every((alternatives) =>
    alternatives.some((alternative) => replyText.includes(normalizeReplyEvidence(alternative)))
  );
  return includesEvidence && (entry.replyRubric !== "confirms" || sawChallenge);
};

const hostedChecks = (
  input: Readonly<{
    entry: HostedCase;
    succeeded: ReadonlyArray<CanonicalOperationId>;
    delivered: boolean;
    replyRubric: boolean;
    confirmationBeforeEffect: boolean;
  }>
): ReadonlyArray<CheckResult> => [
  check(
    "canonical-operations",
    input.entry.operations.every((operation) =>
      input.succeeded.some((candidate) => candidate === operation)
    )
  ),
  check("reply-delivered", input.delivered),
  check("reply-rubric", input.replyRubric),
  check(
    "no-unexpected-mutations",
    input.succeeded.every(
      (operation) => !mutationNames.has(operation) || input.entry.operations.includes(operation)
    )
  ),
  ...(input.entry.coverage.includes("confirmation")
    ? [check("confirmation-before-effect", input.confirmationBeforeEffect)]
    : []),
];

/** Live hosted evaluation never supplies model state or owns the runtime's private Turn lifecycle. */
export const runHosted = Effect.fn("Evaluation.runHosted")(function* (
  entry: HostedCase,
  scenario: Scenario
) {
  const agent = yield* AgentService;
  const seeded = yield* seedTransactions(scenario.client, entry.seed);
  const initialAudit = yield* observeAuditLogEntries(scenario.userId);
  let challenge = Option.none<string>();
  let sawChallenge = false;
  let delivered = true;
  let confirmationBeforeEffect = true;
  const replies: Array<string> = [];
  for (const step of entry.steps) {
    const firstId = Option.map(
      Option.fromUndefinedOr(seeded[0]),
      (transaction) => transaction.data.id
    );
    const text = hostedStepText(step, firstId, challenge);
    if (text === "") {
      delivered = false;
      confirmationBeforeEffect = false;
      break;
    }
    let deliveryCount = 0;
    const reply = yield* agent.handleMessage(
      scenario.userId,
      hostedInbound(step, text),
      () =>
        Effect.sync(() => {
          deliveryCount += 1;
        }),
      "verified-whatsapp"
    );
    if (!validDelivery(deliveryCount, reply.text)) delivered = false;
    replies.push(reply.text);
    challenge = extractChallenge(reply.text);
    if (Option.isSome(challenge)) sawChallenge = true;
    if (step.kind === "delete-first") {
      const observed = yield* observeScenario(scenario.client);
      if (!safeBeforeConfirmation(challenge, entry.seed, observed.facts)) {
        confirmationBeforeEffect = false;
      }
    }
  }
  const audit = (yield* observeAuditLogEntries(scenario.userId)).slice(initialAudit.length);
  const succeeded = audit
    .filter((event) => event.outcome === "succeeded")
    .map((event) => event.operation);
  const observed = yield* observeScenario(scenario.client);
  return [
    ...scoreObservation(entry, observed),
    ...hostedChecks({
      entry,
      succeeded,
      delivered,
      replyRubric: replyRubricMatches(entry, replies, sawChallenge),
      confirmationBeforeEffect,
    }),
  ];
});

const csvCell = (cell: string): string => `"${cell.replaceAll('"', '""')}"`;

/** Deterministic file construction makes the versioned row matrix the source of fixture bytes. */
export const statementBytes = (entry: StatementCase): Uint8Array => {
  if (entry.format === "csv") {
    return new TextEncoder().encode(
      entry.rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n"
    );
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(entry.rows.map((row) => [...row])),
    "Sintético"
  );
  // SheetJS's foreign return is decoded before it is trusted as uploaded bytes.
  return Schema.decodeUnknownSync(Schema.Uint8Array)(
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })
  );
};

const statementFile = (
  format: StatementCase["format"]
): Readonly<{ name: string; mediaType: SubmitForExtractionInput["file"]["declaredMediaType"] }> =>
  format === "xlsx"
    ? {
        name: "synthetic.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }
    : { name: "synthetic.csv", mediaType: "text/csv" };
const maximumMappingAttempts = 3;
const rowAccountingMatches = (
  input: Readonly<{
    inputRows: number;
    acceptedRows: number;
    reviewRows: number;
    entry: StatementCase;
  }>
): boolean =>
  input.inputRows === input.entry.rows.length - 1 &&
  input.acceptedRows === input.entry.expected.length &&
  input.reviewRows === input.entry.reviews.length;

/** Runs accepted rows through the real parser, mapper, SQL queue and final owner capture operations. */
export const runStatement = Effect.fn("Evaluation.runStatement")(function* (
  entry: StatementCase,
  scenario: Scenario
) {
  const crypto = yield* Crypto.Crypto;
  const file = statementFile(entry.format);
  const payload: SubmitForExtractionInput = {
    idempotencyKey: StatementIdempotencyKey.make(yield* crypto.randomUUIDv4),
    file: {
      name: file.name,
      declaredMediaType: file.mediaType,
      contentBase64: Base64FileContent.make(Encoding.encodeBase64(statementBytes(entry))),
    },
  };
  const submitted = yield* scenario.client.ingestion.submitForExtraction({ payload });
  // Exactly the production maximum mapping attempts; no retry-until-green model sampling.
  for (let attempt = 0; attempt < maximumMappingAttempts; attempt += 1) {
    yield* processNextStatement();
    const status = (yield* scenario.client.ingestion.getStatementSubmission({
      params: { id: submitted.data.id },
    })).data;
    if (status.status !== "queued" && status.status !== "processing") break;
  }
  const submission = (yield* scenario.client.ingestion.getStatementSubmission({
    params: { id: submitted.data.id },
  })).data;
  const accounting =
    submission.status === "completed" &&
    rowAccountingMatches({
      inputRows: submission.accounting.inputRows,
      acceptedRows: submission.accounting.acceptedRows,
      reviewRows: submission.accounting.needsReviewRows,
      entry,
    });
  return [
    ...scoreObservation(entry, yield* observeScenario(scenario.client)),
    check("row-accounting", accounting),
  ];
});

const imageMediaType = (
  name: EmailCase["image"]
): "image/jpeg" | "image/webp" | "image/gif" | "image/png" => {
  if (name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "image/png";
};
const webhookTimestampDivisor = 1_000;
const acceptedStatus = 202;

const processEmailDeliveries = Effect.fn("Evaluation.processEmailDeliveries")(function* (
  input: Readonly<{
    ids: ReadonlyArray<ResendReceivedEmailId>;
    address: string;
  }>
) {
  const http = yield* HttpClient.HttpClient;
  const processor = yield* ForwardedEmailProcessor;
  for (const id of input.ids) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const body = yield* Schema.encodeEffect(UnknownJsonString)({
      type: "email.received",
      data: { email_id: id, to: [input.address] },
    });
    const messageId = `evaluation-${id}`;
    const response = yield* http.post("/webhooks/resend", {
      headers: {
        "svix-id": messageId,
        "svix-timestamp": String(Math.floor(now.getTime() / webhookTimestampDivisor)),
        "svix-signature": signResendWebhook({ messageId, timestamp: now, body }),
      },
      body: HttpBody.text(body, "application/json"),
    });
    if (response.status !== acceptedStatus) {
      process.stderr.write(`Evaluation webhook response status: ${response.status}.\n`);
      return yield* new EvaluationFailure({ reason: "harness-failed" });
    }
    yield* processor.processNext;
  }
});

/** Signed local webhook plus fake Resend retrieval; the real Workflow owns interpretation/settlement. */
export const runEmail = Effect.fn("Evaluation.runEmail")(function* (
  entry: EmailCase,
  scenario: Scenario,
  corpus: LoadedCorpus
) {
  const crypto = yield* Crypto.Crypto;
  const address = (yield* scenario.client.ingestion.enableEmailForwarding()).data.address;
  const firstId = ResendReceivedEmailId.make(yield* crypto.randomUUIDv4);
  const nextId = ResendReceivedEmailId.make(yield* crypto.randomUUIDv4);
  const ids =
    entry.delivery === "once"
      ? [firstId]
      : [firstId, entry.delivery === "same-delivery" ? firstId : nextId];
  const receivedAt = DateTime.makeUnsafe("2025-01-20T15:00:00Z");
  const image =
    entry.image === "none"
      ? Option.none<Uint8Array>()
      : Option.fromUndefinedOr(corpus.images.get(entry.image));
  if (entry.image !== "none" && Option.isNone(image)) {
    return yield* new EvaluationFailure({ reason: "invalid-corpus" });
  }
  const mediaType = imageMediaType(entry.image);
  const provider = Layer.succeed(ResendReceivingClient, {
    retrieveEmail: (receivedEmailId: ResendReceivedEmailId) =>
      Effect.succeed(
        ReceivedEmailContent.make({
          receivedEmailId,
          from: "notificaciones@example.test",
          to: [address],
          subject: entry.subject,
          text: Option.some(
            entry.delivery === "distinct-same-money" && receivedEmailId !== firstId
              ? entry.text.replace("15/01/2025", "16/01/2025").replace("A-1", "A-2")
              : entry.text
          ),
          html: Option.none(),
          messageId: Option.some(`synthetic-${receivedEmailId}`),
          createdAt: receivedAt,
          inlineImages: Option.isSome(image)
            ? [{ contentId: "synthetic", mediaType, content: image.value }]
            : [],
        })
      ),
  });
  yield* processEmailDeliveries({ ids, address }).pipe(
    Effect.provide(yield* Layer.build(ForwardedEmailProcessor.layer.pipe(Layer.provide(provider))))
  );
  return scoreObservation(entry, yield* observeScenario(scenario.client));
});
