import { Effect, Option, Schema } from "effect";
import { guardedDatabase } from "./database";
import { type RecoveryMeasurement, makeRecoveryMeasurement } from "./measurement";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { collectBoundedRequestBody } from "../../http/operations";
import { ProtectedReply, ProtectedUnit, maximumErrorLength } from "./protected-contract";
import { maximumReplyBytes, maximumUnitBytes } from "./protected-execution";

const successStatus = 200;
const unavailableStatus = 503;
type StorageEnvironment = Readonly<{ DB: D1Database; ERASURE_BUCKET: R2Bucket }>;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ProtectedUnit));
const encode = Schema.encodeSync(Schema.fromJsonString(ProtectedReply));
const errorMessages = (failure: unknown): ReadonlyArray<string> => {
  const messages: string[] = [];
  let current = failure;
  while (current instanceof Error && messages.length < 4) {
    if (current.message.length > maximumErrorLength) return [];
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
};
const refusal = (failure: unknown, measurement: RecoveryMeasurement): ProtectedReply => {
  const errors = errorMessages(failure);
  return {
    outcome: "refused",
    unavailable: failure instanceof ErasureUnavailable || errors.length === 0,
    errors,
    timing: measurement.snapshot(),
  };
};
const execute = (
  input: Readonly<{
    request: Request;
    environment: StorageEnvironment;
    measurement: RecoveryMeasurement;
  }>
): Promise<ProtectedReply> =>
  Effect.runPromise(collectBoundedRequestBody(input.request, maximumUnitBytes))
    .then((bytes) => {
      try {
        return decode(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new ErasureUnavailable();
      }
    })
    .then((unit) => {
      const db = guardedDatabase({
        db: input.environment.DB,
        bucket: Option.some(input.environment.ERASURE_BUCKET),
        measurement: Option.some(input.measurement),
        execution: Option.none(),
      });
      const source = Option.isNone(unit.bookmark) ? db : db.withSession(unit.bookmark.value);
      const statements = unit.commands.map((command) =>
        source
          .prepare(command.sql)
          .bind(
            ...command.params.map((value) => (Array.isArray(value) ? new Uint8Array(value) : value))
          )
      );
      return source.batch(statements).then((rows): ProtectedReply => ({
        outcome: "completed",
        rows,
        bookmark: "getBookmark" in source ? Option.fromNullOr(source.getBookmark()) : Option.none(),
        timing: input.measurement.snapshot(),
      }));
    })
    .catch((failure: unknown) => refusal(failure, input.measurement));

const response = (reply: ProtectedReply, measurement: RecoveryMeasurement): Response => {
  let body: string;
  try {
    body = encode(reply);
    if (new TextEncoder().encode(body).byteLength > maximumReplyBytes) {
      throw new ErasureUnavailable();
    }
  } catch {
    body = encode(refusal(new ErasureUnavailable(), measurement));
    return new Response(body, {
      status: unavailableStatus,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return new Response(body, {
    status: reply.outcome === "completed" ? successStatus : unavailableStatus,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

export const executeProtectedRequest = (
  input: Readonly<{ request: Request; environment: StorageEnvironment }>
): Promise<Response> => {
  const measurement = makeRecoveryMeasurement();
  return execute({ ...input, measurement }).then((reply) => response(reply, measurement));
};
