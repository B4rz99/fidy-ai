import { Effect, Option, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { collectBoundedRequestBody } from "../../http/operations";
import type { RecoveryMeasurement } from "./measurement";
import { type ProtectedExecution, ProtectedReply, ProtectedUnit } from "./protected-contract";

export const maximumUnitBytes = 4_194_304;
export const maximumReplyBytes = 16_777_216;
const endpoint = "https://protected-storage.internal/execute";
const encode = Schema.encodeSync(Schema.fromJsonString(ProtectedUnit));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ProtectedReply));

const nativeRefusal = (reply: Extract<ProtectedReply, { outcome: "refused" }>): Error => {
  if (reply.unavailable || reply.errors.length === 0) return new ErasureUnavailable();
  let failure: Option.Option<Error> = Option.none();
  for (const message of reply.errors.toReversed()) {
    failure = Option.some(
      Option.isNone(failure) ? new Error(message) : new Error(message, { cause: failure.value })
    );
  }
  return Option.getOrElse(failure, () => new ErasureUnavailable());
};

const readReply = (response: Response): Promise<ProtectedReply> => {
  const body = new Request(endpoint, { method: "POST", body: response.body });
  return Effect.runPromise(collectBoundedRequestBody(body, maximumReplyBytes))
    .then((bytes) => decode(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
    .catch(() => Promise.reject(new ErasureUnavailable()));
};

const execute = (
  input: Readonly<{
    unit: ProtectedUnit;
    binding: Pick<Fetcher, "fetch">;
    measurement: Option.Option<RecoveryMeasurement>;
  }>
): Promise<Readonly<{ rows: D1Result[]; bookmark: Option.Option<D1SessionBookmark> }>> =>
  Promise.resolve()
    .then(() => {
      const body = encode(input.unit);
      if (new TextEncoder().encode(body).byteLength > maximumUnitBytes) {
        throw new ErasureUnavailable();
      }
      return input.binding.fetch(
        new Request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      );
    })
    .then((response) =>
      readReply(response).then((reply) => {
        if (Option.isSome(input.measurement)) input.measurement.value.record(reply.timing);
        if (reply.outcome === "refused") throw nativeRefusal(reply);
        if (!response.ok || reply.rows.length !== input.unit.commands.length) {
          throw new ErasureUnavailable();
        }
        return { rows: reply.rows, bookmark: reply.bookmark };
      })
    );

/** One private attempt per atomic unit. Transport or decode failure never replays a possibly committed operation. */
export const makeProtectedExecution =
  (
    input: Readonly<{
      binding: Pick<Fetcher, "fetch">;
      measurement: Option.Option<RecoveryMeasurement>;
    }>
  ): ProtectedExecution =>
  (unit: ProtectedUnit) => {
    const run: () => ReturnType<ProtectedExecution> = () => execute({ ...input, unit });
    return Option.isSome(input.measurement) ? input.measurement.value.remote(run) : run();
  };
