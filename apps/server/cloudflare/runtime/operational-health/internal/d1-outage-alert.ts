import { Data, Effect, Option, Schema } from "effect";
import type { OperationalAlertDelivery } from "../contract";

class OperatorClaimUnavailable extends Data.TaggedError("OperatorClaimUnavailable") {}
const key = "operational/alerts/d1-v1";
const minuteMs = 60_000;
const repeatMinutes = 30;
const retryMinutes = 5;
const repeatMs = repeatMinutes * minuteMs;
const retryMs = retryMinutes * minuteMs;
const maximumAttempts = 6;
const maximumClaimBytes = 1024;
const maximumReleaseCharacters = 128;
const Claim = Schema.Struct({
  phase: Schema.Literals(["firing", "resolved"]),
  started: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  firingAfter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  next: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumAttempts })),
  confirmed: Schema.Boolean,
  release: Schema.String.check(Schema.isBetweenLength(1, maximumReleaseCharacters)),
});
type Claim = typeof Claim.Type;
type Input = OperationalAlertDelivery &
  Readonly<{
    outageBucket: R2Bucket;
    release: string;
    unavailable: boolean;
  }>;
type StoredClaim = Readonly<{ claim: Claim; etag: string }>;
const codec = Schema.fromJsonString(Claim);
const foreign = <A>(run: () => Promise<A>): Effect.Effect<A, OperatorClaimUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new OperatorClaimUnavailable() }).pipe(
    Effect.timeout("3 seconds"),
    Effect.mapError(() => new OperatorClaimUnavailable())
  );
const readClaim = (
  input: Input
): Effect.Effect<Option.Option<StoredClaim>, OperatorClaimUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const object = Option.fromNullishOr(yield* foreign(() => input.outageBucket.get(key)));
    if (Option.isNone(object)) {
      return Option.none();
    }
    if (object.value.size > maximumClaimBytes) {
      return yield* new OperatorClaimUnavailable();
    }
    const claim = yield* Schema.decodeEffect(codec)(yield* foreign(() => object.value.text()));
    return Option.some({ claim, etag: object.value.etag });
  });
const suppressed = (old: Claim, phase: Claim["phase"], now: number): boolean => {
  if (phase === "firing" && old.phase === "resolved") {
    return old.firingAfter > now;
  }
  if (old.phase !== phase) {
    return false;
  }
  return old.next > now || (phase === "resolved" && old.confirmed);
};
const nextClaim = (input: Input, previous: Option.Option<StoredClaim>): Option.Option<Claim> => {
  const phase = input.unavailable ? "firing" : "resolved";
  if (Option.isNone(previous)) {
    return input.unavailable
      ? Option.some({
          phase,
          started: input.now,
          firingAfter: input.now + repeatMs,
          next: input.now + retryMs,
          attempts: 1,
          confirmed: false,
          release: input.release,
        })
      : Option.none();
  }
  const old = previous.value.claim;
  if (suppressed(old, phase, input.now)) {
    return Option.none();
  }
  const retry = old.phase === phase && !old.confirmed && old.started + repeatMs > input.now;
  if (retry) {
    return retryClaim(old, input.now);
  }
  return newClaim(input, phase, old);
};
const newClaim = (input: Input, phase: Claim["phase"], old: Claim): Option.Option<Claim> =>
  Option.some({
    phase,
    started: input.now,
    firingAfter: phase === "firing" ? input.now + repeatMs : old.firingAfter,
    next: input.now + retryMs,
    attempts: 1,
    confirmed: false,
    release: input.release,
  });
const retryClaim = (old: Claim, now: number): Option.Option<Claim> =>
  old.attempts >= maximumAttempts
    ? Option.none()
    : Option.some({ ...old, next: now + retryMs, attempts: old.attempts + 1, confirmed: false });
const persistClaim = (
  input: Input,
  claim: Claim,
  condition: R2Conditional
): Effect.Effect<Option.Option<string>, OperatorClaimUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(codec)(claim);
    const saved = Option.fromNullishOr(
      yield* foreign(() => input.outageBucket.put(key, body, { onlyIf: condition }))
    );
    return Option.map(saved, (value) => value.etag);
  });
const sendClaim = (
  input: Input,
  claim: Claim,
  etag: string
): Effect.Effect<void, OperatorClaimUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    input.signal.throwIfAborted();
    yield* foreign(() =>
      input.send(
        { kind: "inspection_unavailable", owner: "d1", severity: "critical" },
        `fidy-d1-outage-${claim.phase}-${claim.started}`,
        { signal: input.signal, phase: claim.phase, release: Option.some(claim.release) }
      )
    );
    yield* persistClaim(
      input,
      { ...claim, confirmed: true, next: claim.started + repeatMs },
      { etagMatches: etag }
    );
  });

/** Delivers one D1 outage or resolution through independent durable claims. Caps repeats and retries, preserving the exact email identity after ambiguous delivery. */
export const deliverD1Outage = (input: Input): Effect.Effect<void, OperatorClaimUnavailable> =>
  Effect.gen(function* () {
    input.signal.throwIfAborted();
    const previous = yield* readClaim(input);
    const claim = nextClaim(input, previous);
    if (Option.isNone(claim)) {
      return;
    }
    const condition = Option.match(previous, {
      onNone: (): R2Conditional => ({ etagDoesNotMatch: "*" }),
      onSome: (value): R2Conditional => ({ etagMatches: value.etag }),
    });
    const saved = yield* persistClaim(input, claim.value, condition);
    if (Option.isSome(saved)) {
      yield* sendClaim(input, claim.value, saved.value);
    }
  }).pipe(Effect.mapError(() => new OperatorClaimUnavailable()));
