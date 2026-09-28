import { Option, Schema } from "effect";

const TailOutcome = Schema.Struct({
  outcome: Schema.Literals(["ok", "exception", "exceededCpu", "exceededMemory"]),
  eventTimestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const maximumTailUrlLength = 2_048;
const Callback = Schema.Struct({
  event: Schema.Struct({
    request: Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(maximumTailUrlLength)) }),
    response: Schema.Struct({
      status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
    }),
  }),
});
const minuteMs = 60_000;
const rejectedStatus = 400;
const callbackPaths = new Set(["/providers/kapso/callback", "/providers/wompi/billing-events"]);

export type OperationalEvent = Readonly<{
  kind: "worker_exception" | "resource_limit" | "callback_rejection";
  bucketMs: number;
}>;

const isRejectedCallback = (event: unknown): boolean => {
  const callback = Schema.decodeUnknownOption(Callback)(event);
  if (Option.isNone(callback) || callback.value.event.response.status < rejectedStatus) {
    return false;
  }
  const url = callback.value.event.request.url;
  if (!URL.canParse(url)) return false;
  const address = new URL(url);
  return address.hostname === "api.fidyapp.com" && callbackPaths.has(address.pathname);
};

/** Rebuilds platform tails into finite, identity-free counters; never retains logs, URLs, or errors. */
export const projectOperationalEvents = (
  events: ReadonlyArray<unknown>
): ReadonlyArray<OperationalEvent> =>
  events.flatMap((event): ReadonlyArray<OperationalEvent> => {
    const decoded = Schema.decodeUnknownOption(TailOutcome)(event);
    if (Option.isNone(decoded)) return [];
    const bucketMs = Math.floor(decoded.value.eventTimestamp / minuteMs) * minuteMs;
    if (decoded.value.outcome === "exception") return [{ kind: "worker_exception", bucketMs }];
    if (decoded.value.outcome === "exceededCpu" || decoded.value.outcome === "exceededMemory") {
      return [{ kind: "resource_limit", bucketMs }];
    }
    return isRejectedCallback(event) ? [{ kind: "callback_rejection", bucketMs }] : [];
  });
