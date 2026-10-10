import { Data, Effect, Option, Schema } from "effect";
import type { OperationalAlertDelivery } from "../contract";

class OperatorClaimUnavailable extends Data.TaggedError("OperatorClaimUnavailable") {}
const key = "operational/alerts/d1-v1";
const criticalRepeatMs = 1_800_000;
const warningRepeatMs = 14_400_000;
const retryMs = 300_000;
const maximumSafeRetryMs = 82_800_000;
const maximumAttempts = 6;
const maximumClaimBytes = 1024;
const maximumReleaseLength = 128;
const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Claim = Schema.Struct({
  phase: Schema.Literals(["firing", "resolved"]),
  severity: Schema.Literals(["warning", "critical"]),
  observed: timestamp,
  started: timestamp,
  firingAfter: timestamp,
  next: timestamp,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumAttempts })),
  confirmed: Schema.Boolean,
  acknowledged: Schema.Boolean,
  release: Schema.String.check(Schema.isBetweenLength(1, maximumReleaseLength)),
});
type Claim = typeof Claim.Type;
type Input = OperationalAlertDelivery &
  Readonly<{
    outageBucket: R2Bucket;
    release: string;
    inspection: "healthy" | "unavailable" | "unknown";
    severity: Claim["severity"];
  }>;
type StoredClaim = Readonly<{ claim: Claim; etag: string }>;
type Admission = Readonly<{ claim: Claim; send: boolean }>;
const codec = Schema.fromJsonString(Claim);
const repeatMs = (severity: Claim["severity"]): number =>
  severity === "critical" ? criticalRepeatMs : warningRepeatMs;
const foreign = <A>(
  run: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, OperatorClaimUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new OperatorClaimUnavailable() }).pipe(
    Effect.timeout("3 seconds"),
    Effect.mapError(() => new OperatorClaimUnavailable())
  );
const findClaim = (
  input: Input
): Effect.Effect<Option.Option<StoredClaim>, OperatorClaimUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const object = Option.fromNullishOr(yield* foreign(() => input.outageBucket.get(key)));
    if (Option.isNone(object)) return Option.none();
    if (object.value.size > maximumClaimBytes) return yield* new OperatorClaimUnavailable();
    const claim = yield* Schema.decodeEffect(codec)(yield* foreign(() => object.value.text()));
    return Option.some({ claim, etag: object.value.etag });
  });
const suppressed = (old: Claim, phase: Claim["phase"], now: number): boolean => {
  if (phase === "firing" && old.phase === "resolved") return old.firingAfter > now;
  if (old.phase !== phase) return false;
  return old.next > now || (phase === "resolved" ? old.confirmed : old.acknowledged);
};
const newClaim = (
  input: Input,
  state: Pick<Claim, "phase" | "firingAfter" | "severity">
): Claim => ({
  phase: state.phase,
  severity: state.severity,
  observed: input.now,
  started: input.now,
  firingAfter: state.phase === "firing" ? input.now + repeatMs(state.severity) : state.firingAfter,
  next: input.now + retryMs,
  attempts: 1,
  confirmed: false,
  acknowledged: false,
  release: input.release,
});
const nextClaim = (
  input: Input,
  previous: Option.Option<StoredClaim>
): Option.Option<Admission> => {
  if (input.inspection === "unknown") return recordUnknownObservation(input, previous);
  const phase = input.inspection === "unavailable" ? "firing" : "resolved";
  if (Option.isNone(previous)) {
    return phase === "firing"
      ? Option.some({
          claim: newClaim(input, { phase, firingAfter: 0, severity: input.severity }),
          send: true,
        })
      : Option.none();
  }
  return nextObservedClaim(input, previous.value.claim, phase);
};
const recordUnknownObservation = (
  input: Input,
  previous: Option.Option<StoredClaim>
): Option.Option<Admission> =>
  previous.pipe(
    Option.filter(({ claim }) => input.now > claim.observed),
    Option.map(({ claim }) => ({ claim: { ...claim, observed: input.now }, send: false }))
  );
const nextObservedClaim = (
  input: Input,
  old: Claim,
  phase: Claim["phase"]
): Option.Option<Admission> => {
  if (input.now <= old.observed) return Option.none();
  if (phase === "firing" && old.phase === "firing" && old.severity !== input.severity) {
    return Option.some({
      claim: newClaim(input, { phase, firingAfter: old.firingAfter, severity: input.severity }),
      send: true,
    });
  }
  const observation: Admission = { claim: { ...old, observed: input.now }, send: false };
  if (suppressed(old, phase, input.now)) return Option.some(observation);
  return Option.some(admitDelivery(input, old, phase));
};
const admitDelivery = (input: Input, old: Claim, phase: Claim["phase"]): Admission => {
  const retry =
    old.phase === phase && !old.confirmed && old.started + maximumSafeRetryMs > input.now;
  if (retry) {
    return old.attempts >= maximumAttempts
      ? { claim: { ...old, observed: input.now }, send: false }
      : {
          claim: {
            ...old,
            observed: input.now,
            next: input.now + retryMs,
            attempts: old.attempts + 1,
          },
          send: true,
        };
  }
  return {
    claim: newClaim(input, {
      phase,
      firingAfter: old.firingAfter,
      severity: phase === "resolved" ? old.severity : input.severity,
    }),
    send: true,
  };
};

const persistClaim = (
  input: Input,
  claim: Claim,
  condition: R2Conditional
): Effect.Effect<Option.Option<string>, OperatorClaimUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    input.signal.throwIfAborted();
    const body = yield* Schema.encodeEffect(codec)(claim);
    const saved = Option.fromNullishOr(
      yield* foreign(() => input.outageBucket.put(key, body, { onlyIf: condition }))
    );
    return Option.map(saved, (value) => value.etag);
  });
const confirmClaim = (
  input: Input,
  claim: Claim,
  etag: string
): Effect.Effect<void, OperatorClaimUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const confirmed = { ...claim, confirmed: true, next: claim.started + repeatMs(claim.severity) };
    const saved = yield* persistClaim(input, confirmed, { etagMatches: etag });
    if (Option.isSome(saved)) return;
    // A concurrent observation or operator acknowledgement must survive confirmation.
    const latest = yield* findClaim(input);
    if (Option.isNone(latest)) return;
    const current = latest.value.claim;
    if (
      current.phase !== claim.phase ||
      current.started !== claim.started ||
      current.severity !== claim.severity
    ) {
      return;
    }
    yield* persistClaim(
      input,
      { ...current, confirmed: true, next: confirmed.next },
      { etagMatches: latest.value.etag }
    );
  });
const sendClaim = (
  input: Input,
  claim: Claim,
  etag: string
): Effect.Effect<void, OperatorClaimUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    input.signal.throwIfAborted();
    yield* foreign((signal) =>
      input.send(
        { kind: "inspection_unavailable", owner: "d1", severity: claim.severity },
        `fidy-d1-outage-${claim.severity}-${claim.phase}-${claim.started}`,
        { signal, phase: claim.phase, release: Option.some(claim.release) }
      )
    );
    yield* confirmClaim(input, claim, etag);
  });

/** Delivers bounded D1 outage notifications through independent durable claims; only healthy inspection resolves them. */
export const deliverD1Outage = (input: Input): Effect.Effect<void, OperatorClaimUnavailable> =>
  Effect.gen(function* () {
    input.signal.throwIfAborted();
    const previous = yield* findClaim(input);
    const admission = nextClaim(input, previous);
    if (Option.isNone(admission)) return;
    const condition = Option.match(previous, {
      onNone: (): R2Conditional => ({ etagDoesNotMatch: "*" }),
      onSome: (value): R2Conditional => ({ etagMatches: value.etag }),
    });
    const { claim, send } = admission.value;
    const saved = yield* persistClaim(input, claim, condition);
    if (send && Option.isSome(saved)) yield* sendClaim(input, claim, saved.value);
  }).pipe(Effect.mapError(() => new OperatorClaimUnavailable()));
