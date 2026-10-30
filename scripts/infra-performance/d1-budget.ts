import { Clock, DateTime, Effect, Option, Schema } from "effect";

/** Account-wide Free limits: an isolated test database still spends production's allowance. */
export const freeD1BenchmarkLimits = {
  dailyReads: 5_000_000,
  dailyWrites: 100_000,
  reservedReads: 2_500_000,
  reservedWrites: 50_000,
  experimentReads: 100_000,
  experimentWrites: 5_000,
  observationAgeMs: 60_000,
} as const;

const count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const maximumDateEpochMs = 8_640_000_000_000_000;
const epochMs = count.check(Schema.isLessThanOrEqualTo(maximumDateEpochMs));
const BudgetInput = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  nowEpochMs: epochMs,
  observation: Schema.Struct({
    accountId: Schema.String,
    utcDate: Schema.String,
    observedAtEpochMs: epochMs,
    rowsRead: count,
    rowsWritten: count,
  }),
  estimate: Schema.Struct({ rowsRead: count, rowsWritten: count }),
});

type BudgetRefusal =
  | "invalid_observation"
  | "stale_observation"
  | "wrong_utc_day"
  | "experiment_too_large"
  | "production_reserve";
export type D1BenchmarkBudgetDecision =
  | Readonly<{ _tag: "Refused"; reason: BudgetRefusal }>
  | Readonly<{ _tag: "Allowed"; maximumRowsRead: number; maximumRowsWritten: number }>;

const isoDateLength = 10;
/** A conservative preflight, not a reservation: unknown, stale or another account's usage refuses.
 * The caller must obtain fresh account-wide analytics, including deleted fixture databases, before
 * provisioning and enforce the admitted experiment ceiling against every native batch's metadata.
 */
export const assessFreeD1BenchmarkBudget = (raw: unknown): D1BenchmarkBudgetDecision => {
  const decoded = Schema.decodeUnknownOption(BudgetInput)(raw);
  if (Option.isNone(decoded)) return { _tag: "Refused", reason: "invalid_observation" };
  const observationRefusal = validateObservation(decoded.value);
  return Option.isSome(observationRefusal)
    ? { _tag: "Refused", reason: observationRefusal.value }
    : assessEstimate(decoded.value);
};

const validateObservation = ({
  accountId,
  nowEpochMs,
  observation,
}: typeof BudgetInput.Type): Option.Option<BudgetRefusal> => {
  if (observation.accountId !== accountId) return Option.some("invalid_observation");
  const age = nowEpochMs - observation.observedAtEpochMs;
  if (age < 0 || age > freeD1BenchmarkLimits.observationAgeMs) {
    return Option.some("stale_observation");
  }
  return observation.utcDate !==
    DateTime.formatIso(DateTime.makeUnsafe(nowEpochMs)).slice(0, isoDateLength)
    ? Option.some("wrong_utc_day")
    : Option.none();
};

const assessEstimate = ({
  observation,
  estimate,
}: typeof BudgetInput.Type): D1BenchmarkBudgetDecision => {
  if (
    estimate.rowsRead > freeD1BenchmarkLimits.experimentReads ||
    estimate.rowsWritten > freeD1BenchmarkLimits.experimentWrites
  ) {
    return { _tag: "Refused", reason: "experiment_too_large" };
  }
  if (
    observation.rowsRead + estimate.rowsRead >
      freeD1BenchmarkLimits.dailyReads - freeD1BenchmarkLimits.reservedReads ||
    observation.rowsWritten + estimate.rowsWritten >
      freeD1BenchmarkLimits.dailyWrites - freeD1BenchmarkLimits.reservedWrites
  ) {
    return { _tag: "Refused", reason: "production_reserve" };
  }
  return {
    _tag: "Allowed",
    maximumRowsRead: estimate.rowsRead,
    maximumRowsWritten: estimate.rowsWritten,
  };
};

if (import.meta.main) {
  const raw: unknown = await Bun.stdin.json().catch(() => undefined);
  const frame = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(raw);
  const nowEpochMs = await Effect.runPromise(Clock.currentTimeMillis);
  const decision = assessFreeD1BenchmarkBudget(
    Option.isSome(frame) ? { ...frame.value, nowEpochMs } : raw
  );
  const wire = await Effect.runPromise(
    Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(decision)
  );
  await Bun.write(Bun.stdout, `${wire}\n`);
  process.exitCode = decision._tag === "Allowed" ? 0 : 1;
}
